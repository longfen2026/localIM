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

const store = new Store(config.DATA_DIR);

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

/* ---------------- 图片上传 ---------------- */

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    // 按月份分目录，避免单目录文件过多
    const d = new Date();
    const sub = path.join(
      config.UPLOAD_DIR,
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
    const ext = EXT_BY_MIME[file.mimetype] || '.bin';
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME.includes(file.mimetype)) cb(null, true);
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
    if (!req.user) {
      // 未登录：把按 IP 派生好的名字一起返回，前端直接预填
      return res.json({ user: null, ip, suggestedName: deriveName(ip, takenNamesExcept(null)) });
    }
    store.touchUser(req.user.id);
    const user = syncAutoName(req.user, ip);
    res.json({
      user: { id: user.id, name: user.name },
      ip,
      suggestedName: deriveName(ip, takenNamesExcept(user.id)),
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

  // 图片上传：返回 fileId，随后通过 WebSocket 发送引用
  app.post('/api/upload', (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: '未登录' });
    next();
  }, upload.single('image'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: '没有收到图片' });
    if (!allowUpload(req.user.id)) {
      fs.unlink(req.file.path, () => {});
      return res.status(429).json({ error: '上传过于频繁，请稍后再试' });
    }
    try {
      const head = Buffer.alloc(64);
      const fh = await fsp.open(req.file.path, 'r');
      await fh.read(head, 0, 64, 0);
      await fh.close();
      const size = imageSize(head);

      const rel = '/' + path.relative(config.UPLOAD_DIR, req.file.path).split(path.sep).join('/');
      const fileId = crypto.randomBytes(12).toString('hex');
      store.addPendingUpload(fileId, {
        userId: req.user.id,
        url: '/uploads' + rel,
        w: size ? size.w : null,
        h: size ? size.h : null,
        size: req.file.size,
        name: cleanName(req.file.originalname) || 'image',
      });
      res.json({ fileId });
    } catch (e) {
      fs.unlink(req.file.path, () => {});
      res.status(500).json({ error: '上传处理失败' });
    }
  });

  app.use('/uploads', express.static(config.UPLOAD_DIR, {
    maxAge: '30d',
    immutable: true,
    fallthrough: false,
  }));

  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: 0 }));

  app.use((err, _req, res, _next) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `图片超过 ${config.MAX_UPLOAD_MB}MB` });
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
      // 图片消息
      if (p.fileId) {
        const info = store.takePendingUpload(String(p.fileId), user.id);
        if (!info) return done('图片已失效，请重新上传');
        const text = cleanText(p.text).trim();
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

      // 文本消息
      const text = cleanText(p.text).trim();
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
