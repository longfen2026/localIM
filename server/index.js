'use strict';

const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const http = require('http');

const express = require('express');
const cookieParser = require('cookie-parser');
const cookie = require('cookie');
const signature = require('cookie-signature');
const multer = require('multer');
const proxyAddr = require('proxy-addr');
const { Server } = require('socket.io');

const config = require('./config');
const Store = require('./store');
const { imageSize, EXT_BY_MIME, ALLOWED_MIME } = require('./media');
const { deriveName, isAutoName } = require('./identity');

const store = new Store(config.DATA_DIR, { fileGcMinutes: config.FILE_GC_MINUTES });

/* ---------------- 工具 ---------------- */

function cleanName(input) {
  return String(input || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, config.MAX_NAME_LEN);
}

function cleanText(input) {
  return String(input || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, config.MAX_TEXT_LEN);
}

/** 简易滑动窗口限流 */
function rateLimiter(limit, windowMs) {
  const hits = new Map();
  return function allow(key) {
    const now = Date.now();
    let arr = hits.get(key);
    if (!arr) { arr = []; hits.set(key, arr); }
    while (arr.length && now - arr[0] > windowMs) arr.shift();
    if (arr.length >= limit) return false;
    arr.push(now);
    if (hits.size > 5000) {
      for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k);
    }
    return true;
  };
}

const allowMessage = rateLimiter(config.RATE_MAX_MSG, config.RATE_WINDOW_MS);
const allowUpload = rateLimiter(config.RATE_MAX_UPLOAD, 60 * 1000);

/* ---------------- 客户端 IP ---------------- */

// 统一 HTTP 与 WebSocket 的取 IP 逻辑：Socket.IO 的 handshake.address 不认
// X-Forwarded-For，在反代后面会拿到代理自己的地址，这里手动按同样的规则解析。
const TRUST_PROXY = (function () {
  const v = String(config.TRUST_PROXY).trim();
  if (v === 'true' || v === '1') return () => true;
  if (v === 'false' || v === '0' || v === '') return () => false;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
})();

function clientIp(req) {
  try {
    return proxyAddr(req, TRUST_PROXY) || '';
  } catch (_) {
    return (req && req.socket && req.socket.remoteAddress) || '';
  }
}

/* ---------------- 图片 / 文件上传 ---------------- */

// 文件有效期（毫秒），从上传时刻起算；同时编码进落盘文件名，供 GC 扫磁盘兜底清理
const FILE_TTL_MS = Math.max(0, config.FILE_TTL_HOURS) * 3600 * 1000;

/** 从原始文件名提取安全扩展名（不含路径成分，限长），无则 .bin */
function safeExt(originalname, fallback) {
  const ext = path.extname(String(originalname || '')).slice(0, 11);
  return /^[.][A-Za-z0-9_-]*$/.test(ext) ? ext : (fallback || '.bin');
}

/** 清洗聊天文件名：去控制字符/路径分隔符，保留中文与空格，限长 */
function cleanFileName(input) {
  return String(input || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '')
    .slice(0, 120) || '未命名文件';
}

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    // 按月份分目录，避免单目录文件过多；图片与文件分目录（生命周期不同）
    const d = new Date();
    const sub = path.join(
      file.fieldname === 'file' ? config.FILE_DIR : config.UPLOAD_DIR,
      `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`
    );
    try {
      await fsp.mkdir(sub, { recursive: true });
      cb(null, sub);
    } catch (e) {
      cb(e);
    }
  },
  filename: (req, file, cb) => {
    if (file.fieldname === 'file') {
      // ${fileId}-${expiresAt}${ext}：过期时间写进文件名，清理时直接扫磁盘
      const fileId = crypto.randomBytes(12).toString('hex');
      const expiresAt = Date.now() + FILE_TTL_MS;
      req.fileMeta = { fileId, expiresAt };
      cb(null, `${fileId}-${expiresAt}${safeExt(file.originalname)}`);
    } else {
      const ext = EXT_BY_MIME[file.mimetype] || '.bin';
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
    }
  },
});

const upload = multer({
  storage,
  // multipart 文件名按 UTF-8 解析（默认 latin1 会把中文文件名变成乱码）
  defParamCharset: 'utf8',
  limits: {
    // multer 的 fileSize 是所有字段共用的粗筛，取两种上限的较大值；
    // MAX_FILE_MB=0 表示文件不限大小，此时粗筛放行，精确校验在接口里做
    fileSize: config.MAX_FILE_MB > 0
      ? Math.max(config.MAX_UPLOAD_MB, config.MAX_FILE_MB) * 1024 * 1024
      : Infinity,
    files: 1,
  },
  fileFilter: (req, file, cb) => {
    // 图片字段维持 MIME 白名单；文件字段不限制类型（局域网可信环境），大小由 limits 管
    if (file.fieldname !== 'image' || ALLOWED_MIME.includes(file.mimetype)) cb(null, true);
    else cb(new Error('UNSUPPORTED_TYPE'));
  },
});

/* ---------------- 应用 ---------------- */

async function main() {
  await store.init();

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, {
    maxHttpBufferSize: 2 * 1024 * 1024,
    pingInterval: 20000,
    pingTimeout: 20000,
  });

  app.disable('x-powered-by');
  // 只信任来自本机/内网代理的 X-Forwarded-For，防止局域网内伪造 IP 冒用身份
  app.set('trust proxy', TRUST_PROXY);
  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser(store.secret));

  // 鉴权中间件：读取签名 Cookie 找到用户
  app.use((req, _res, next) => {
    const uid = req.signedCookies && req.signedCookies[config.COOKIE_USER];
    req.user = uid ? store.getUser(uid) : null;
    next();
  });

  function setAuthCookies(res, user) {
    res.cookie(config.COOKIE_USER, user.id, {
      signed: true,
      httpOnly: true,
      sameSite: 'lax',
      maxAge: config.COOKIE_MAX_AGE,
    });
    res.cookie(config.COOKIE_NAME, encodeURIComponent(user.name), {
      httpOnly: false,
      sameSite: 'lax',
      maxAge: config.COOKIE_MAX_AGE,
    });
  }

  /* ---------- HTTP 接口 ---------- */

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, users: Object.keys(store.users).length, messages: store.messages.length });
  });

  // 当前登录状态（浏览器打开页面时先调它，用于自动登录）
  app.get('/api/me', (req, res) => {
    const ip = clientIp(req);
    // 把上传上限一起下发，前端校验与服务端保持一致
    const limits = { maxImageMB: config.MAX_UPLOAD_MB, maxFileMB: config.MAX_FILE_MB, fileTtlHours: config.FILE_TTL_HOURS };
    if (!req.user) {
      // 未登录：把按 IP 派生好的名字一起返回，前端直接预填
      return res.json({ user: null, ip, suggestedName: deriveName(ip, takenNamesExcept(null)), limits });
    }
    store.touchUser(req.user.id);
    const user = syncAutoName(req.user, ip);
    res.json({
      user: { id: user.id, name: user.name },
      ip,
      suggestedName: deriveName(ip, takenNamesExcept(user.id)),
      limits,
    });
  });

  // 登录 / 改名：名字留空则按内网 IP 自动派生（192.168.5.102 → ID102）
  app.post('/api/login', (req, res) => {
    const raw = cleanName((req.body && req.body.name) || '');
    const name = raw || deriveName(clientIp(req), takenNamesExcept((req.user && req.user.id) || null));
    if (!name) return res.status(400).json({ error: '请输入用户名' });
    const id = (req.user && req.user.id) || crypto.randomBytes(12).toString('hex');
    const user = store.upsertUser(id, name);
    setAuthCookies(res, user);
    broadcastPresence();
    res.json({ user: { id: user.id, name: user.name } });
  });

  app.post('/api/logout', (req, res) => {
    res.clearCookie(config.COOKIE_USER);
    res.clearCookie(config.COOKIE_NAME);
    broadcastPresence();
    res.json({ ok: true });
  });

  // 历史消息（供调试 / 外部取用；聊天室主要通过 WebSocket 获取）
  app.get('/api/messages', (req, res) => {
    if (!req.user) return res.status(401).json({ error: '未登录' });
    const limit = Math.min(Number(req.query.limit) || config.HISTORY_PAGE, config.MAX_HISTORY);
    const before = req.query.before ? Number(req.query.before) : undefined;
    res.json(store.recent(limit, Number.isFinite(before) ? before : undefined));
  });

  // 上传：image 字段为图片（MIME 白名单，长期保存），file 字段为任意文件（暂存，
  // 有效期 FILE_TTL_HOURS，过期由 GC 清理）。都返回 fileId，随后通过 WebSocket 发送引用。
  app.post('/api/upload', (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: '未登录' });
    next();
  }, upload.fields([{ name: 'image', maxCount: 1 }, { name: 'file', maxCount: 1 }]), async (req, res) => {
    const img = req.files && req.files.image && req.files.image[0];
    const doc = req.files && req.files.file && req.files.file[0];
    if (!img && !doc) return res.status(400).json({ error: '没有收到文件' });
    // multer 的 fileSize 上限是所有字段共用的大值，这里按字段精确校验
    if (img && img.size > config.MAX_UPLOAD_MB * 1024 * 1024) {
      fs.unlink(img.path, () => {});
      return res.status(413).json({ error: `图片超过 ${config.MAX_UPLOAD_MB}MB` });
    }
    if (doc && config.MAX_FILE_MB > 0 && doc.size > config.MAX_FILE_MB * 1024 * 1024) {
      fs.unlink(doc.path, () => {});
      return res.status(413).json({ error: `文件超过 ${config.MAX_FILE_MB}MB` });
    }
    if (!allowUpload(req.user.id)) {
      if (img) fs.unlink(img.path, () => {});
      if (doc) fs.unlink(doc.path, () => {});
      return res.status(429).json({ error: '上传过于频繁，请稍后再试' });
    }

    try {
      /* 图片：解析真实宽高（只读文件头），消息里长期引用 */
      if (img) {
        const head = Buffer.alloc(64);
        const fh = await fsp.open(img.path, 'r');
        await fh.read(head, 0, 64, 0);
        await fh.close();
        const size = imageSize(head);

        const rel = '/' + path.relative(config.UPLOAD_DIR, img.path).split(path.sep).join('/');
        const fileId = crypto.randomBytes(12).toString('hex');
        store.addPendingUpload(fileId, {
          userId: req.user.id,
          url: '/uploads' + rel,
          w: size ? size.w : null,
          h: size ? size.h : null,
          size: img.size,
          name: cleanName(img.originalname) || 'image',
        });
        return res.json({ fileId, kind: 'image' });
      }

      /* 文件：暂存，过期时间已编码进落盘文件名（req.fileMeta 由 storage 生成） */
      const meta = req.fileMeta || {};
      const fileId = meta.fileId || crypto.randomBytes(12).toString('hex');
      const expiresAt = meta.expiresAt || (Date.now() + FILE_TTL_MS);
      const rel = path.relative(config.FILE_DIR, doc.path).split(path.sep).join('/');
      store.addPendingFile(fileId, {
        userId: req.user.id,
        rel,
        name: cleanFileName(doc.originalname),
        mime: doc.mimetype || 'application/octet-stream',
        size: doc.size,
        expiresAt,
      });
      res.json({ fileId, kind: 'file', name: cleanFileName(doc.originalname), size: doc.size, expiresAt });
    } catch (e) {
      if (img) fs.unlink(img.path, () => {});
      if (doc) fs.unlink(doc.path, () => {});
      res.status(500).json({ error: '上传处理失败' });
    }
  });

  // 文件下载：按 fileId 定位（已发送的在注册表，未发送的在 pending，都能下载）；
  // 过期或已被清理则 410/404。
  // 强制 attachment + nosniff，即使上传的是 HTML/SVG 也只会被保存而不会在浏览器渲染。
  app.get('/api/files/:fileId', (req, res) => {
    const fileId = String(req.params.fileId || '');
    if (!/^[0-9a-f]{6,64}$/.test(fileId)) return res.status(400).json({ error: '无效的文件标识' });
    const entry = store.getFile(fileId) || store.peekPendingFile(fileId);
    if (!entry) return res.status(404).json({ error: '文件不存在或已被清理' });
    if (entry.expiresAt < Date.now()) return res.status(410).json({ error: '文件已过期（超过24小时）' });
    const abs = store.absFile(entry);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.download(abs, entry.name, (err) => {
      if (err && !res.headersSent) {
        // 注册表在但磁盘文件没了（如被手动删除）：视同过期
        res.status(404).json({ error: '文件不存在或已被清理' });
      }
    });
  });

  app.use('/uploads', express.static(config.UPLOAD_DIR, {
    maxAge: '30d',
    immutable: true,
    fallthrough: false,
  }));

  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: 0 }));

  app.use((err, _req, res, _next) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      // 按上传字段区分文案：image 是图片，file 是任意文件
      const isFile = err.field === 'file';
      const mb = isFile ? config.MAX_FILE_MB : config.MAX_UPLOAD_MB;
      return res.status(413).json({ error: `${isFile ? '文件' : '图片'}超过 ${mb}MB` });
    }
    if (err && err.message === 'UNSUPPORTED_TYPE') {
      return res.status(415).json({ error: '仅支持 PNG / JPG / GIF / WEBP / BMP' });
    }
    console.error('[http]', err && err.message);
    res.status(500).json({ error: '服务器内部错误' });
  });

  /* ---------- WebSocket ---------- */

  const online = new Map(); // socketId -> {id, name}

  /** 当前在线用户已占用的名字（排除自己），用于自动命名时避让 */
  function takenNamesExcept(userId) {
    const s = new Set();
    for (const u of online.values()) {
      if (u.id !== userId) s.add(u.name);
    }
    return s;
  }

  /**
   * 名字是自动派生（ID102 这种）的用户，IP 变了就跟着更新；
   * 手动改过名字的用户不会被覆盖。
   */
  function syncAutoName(user, ip) {
    if (!isAutoName(user.name)) return user;
    const want = deriveName(ip, takenNamesExcept(user.id));
    if (want === user.name) return user;
    store.upsertUser(user.id, want);
    for (const [sid, u] of online) {
      if (u.id === user.id) online.set(sid, { id: user.id, name: want });
    }
    broadcastPresence();
    return { id: user.id, name: want };
  }

  function presenceList() {
    const map = new Map();
    for (const u of online.values()) map.set(u.id, u.name);
    return [...map.entries()].map(([id, name]) => ({ id, name }));
  }

  function broadcastPresence() {
    io.emit('presence', { online: presenceList() });
  }

  io.use((socket, next) => {
    const raw = socket.request.headers.cookie;
    if (!raw) return next(new Error('UNAUTHORIZED'));
    const token = cookie.parse(raw)[config.COOKIE_USER];
    const uid = token && token.startsWith('s:') ? signature.unsign(token.slice(2), store.secret) : false;
    if (uid === false) return next(new Error('UNAUTHORIZED'));
    const user = store.getUser(uid);
    if (!user) return next(new Error('UNAUTHORIZED'));
    socket.data.user = { id: user.id, name: user.name };
    socket.data.ip = clientIp(socket.request);
    next();
  });

  io.on('connection', (socket) => {
    // 进入聊天室时按当前 IP 校准自动派生的名字（手动改过的不动）
    let user = syncAutoName(socket.data.user, socket.data.ip);
    socket.data.user = user;
    online.set(socket.id, user);
    store.upsertUser(user.id, user.name);

    socket.emit('init', {
      me: user,
      ...store.recent(config.HISTORY_PAGE),
      online: presenceList(),
    });

    socket.broadcast.emit('sys', { text: `${user.name} 加入了聊天室`, ts: Date.now() });
    broadcastPresence();

    // 拉取更早的历史
    socket.on('history:load', (payload, ack) => {
      const before = payload && Number(payload.before);
      const limit = Math.min(Number((payload && payload.limit) || config.HISTORY_PAGE), 200);
      const res = store.recent(limit, Number.isFinite(before) ? before : undefined);
      if (typeof ack === 'function') ack({ ok: true, ...res });
    });

    socket.on('msg:send', (payload, ack) => {
      const done = (err, msg) => { if (typeof ack === 'function') ack(err ? { error: err } : { ok: true, message: msg }); };
      if (!allowMessage(user.id)) return done('发送过于频繁，请稍后再试');

      const p = payload || {};
      const text = cleanText(p.text).trim();
      // 图片消息
      if (p.fileId && p.kind !== 'file') {
        const info = store.takePendingUpload(String(p.fileId), user.id);
        if (!info) return done('图片已失效，请重新上传');
        const msg = store.addMessage({
          type: 'image',
          userId: user.id,
          name: user.name,
          text,
          image: { url: info.url, w: info.w, h: info.h, size: info.size, name: info.name },
        });
        io.emit('msg:new', msg);
        return done(null, msg);
      }

      // 文件消息（非图片）：暂存到过期为止
      if (p.fileId && p.kind === 'file') {
        const info = store.takePendingFile(String(p.fileId), user.id);
        if (!info) return done('文件已失效，请重新上传');
        const msg = store.addMessage({
          type: 'file',
          userId: user.id,
          name: user.name,
          text,
          file: {
            id: String(p.fileId),
            name: info.name,
            mime: info.mime,
            size: info.size,
            expiresAt: info.expiresAt,
          },
        });
        io.emit('msg:new', msg);
        return done(null, msg);
      }

      // 文本消息
      if (!text) return done('消息不能为空');
      const msg = store.addMessage({ type: 'text', userId: user.id, name: user.name, text });
      io.emit('msg:new', msg);
      done(null, msg);
    });

    socket.on('disconnect', () => {
      online.delete(socket.id);
      if (!presenceList().some((u) => u.id === user.id)) {
        socket.broadcast.emit('sys', { text: `${user.name} 离开了聊天室`, ts: Date.now() });
      }
      broadcastPresence();
    });
  });

  server.listen(config.PORT, config.HOST, () => {
    console.log(`[localIM] 服务端已启动: http://${config.HOST}:${config.PORT}`);
    console.log(`[localIM] 数据目录: ${config.DATA_DIR}`);
    console.log(`[localIM] 已载入 ${store.messages.length} 条历史消息，${Object.keys(store.users).length} 个用户`);
  });
}

main().catch((e) => {
  console.error('启动失败:', e);
  process.exit(1);
});
