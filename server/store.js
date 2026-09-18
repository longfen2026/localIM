'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const MESSAGES_FILE = 'messages.jsonl';
const USERS_FILE = 'users.json';
const FILES_FILE = 'files.json';
const SECRET_FILE = '.cookie-secret';

/**
 * 极简持久化层：
 * - 消息：append-only 的 JSONL（每行一条），启动时全量载入内存
 * - 用户：单个 JSON 文件，变更时防抖写回
 * - 图片：直接落盘到 uploads/，只在消息里记录相对路径
 * - 文件：落盘到 files/，过期信息编码在文件名里；已发送的文件再登记到
 *   files.json（fileId → 元数据），供下载接口按 fileId 定位与鉴权
 * 全部文件都位于 DATA_DIR（Docker 中映射到宿主机），重启容器数据不丢。
 */
class Store {
  /**
   * @param {string} dataDir 数据目录
   * @param {{fileGcMinutes?: number}} [opts] fileGcMinutes: 过期文件清理扫描间隔（分钟）
   */
  constructor(dataDir, opts) {
    this.dir = dataDir;
    this.uploadDir = path.join(dataDir, 'uploads');
    this.fileDir = path.join(dataDir, 'files');
    this.fileGcMinutes = (opts && opts.fileGcMinutes) || 10;
    this.messages = [];
    this.users = {};
    this.files = {};      // fileId -> {rel, name, mime, size, expiresAt, uploader, ts}（已发送的文件）
    this.seq = 0;
    this.secret = '';
    this.pendingUploads = new Map(); // fileId -> {userId, url, w, h, size, name, ts}
    this.pendingFiles = new Map();   // fileId -> {userId, rel, name, mime, size, expiresAt, ts}
    this._chain = Promise.resolve();
    this._userSaveTimer = null;
  }

  async init() {
    await fsp.mkdir(this.uploadDir, { recursive: true });
    await fsp.mkdir(this.fileDir, { recursive: true });
    this.secret = await this._loadSecret();
    await this._loadUsers();
    await this._loadMessages();
    await this._loadFiles();
    this._startUploadGC();
    this._startFileGC();
  }

  /* ---------------- Cookie 签名密钥（持久化，重启后旧 Cookie 仍有效） -------- */

  async _loadSecret() {
    const file = path.join(this.dir, SECRET_FILE);
    try {
      const s = await fsp.readFile(file, 'utf8');
      if (s.trim()) return s.trim();
    } catch (_) { /* 不存在则生成 */ }
    const s = crypto.randomBytes(32).toString('hex');
    await fsp.writeFile(file, s, { mode: 0o600 });
    return s;
  }

  /* ---------------- 用户 ---------------- */

  async _loadUsers() {
    const file = path.join(this.dir, USERS_FILE);
    try {
      this.users = JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch (_) {
      this.users = {};
      await this._writeUsersNow();
    }
  }

  getUser(id) {
    return this.users[id] || null;
  }

  upsertUser(id, name) {
    const now = Date.now();
    const u = this.users[id] || { id, createdAt: now };
    u.name = name;
    u.lastSeen = now;
    this.users[id] = u;
    this._saveUsers();
    return u;
  }

  touchUser(id) {
    if (this.users[id]) {
      this.users[id].lastSeen = Date.now();
      this._saveUsers();
    }
  }

  _saveUsers() {
    if (this._userSaveTimer) return;
    this._userSaveTimer = setTimeout(() => {
      this._userSaveTimer = null;
      this._writeUsersNow().catch((e) => console.error('[store] 保存用户失败:', e.message));
    }, 800);
  }

  async _writeUsersNow() {
    const file = path.join(this.dir, USERS_FILE);
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(this.users, null, 2), 'utf8');
    await fsp.rename(tmp, file);
  }

  /* ---------------- 消息 ---------------- */

  /**
   * 载入消息日志。被删除的消息以"墓碑行"记录：
   *   { id, ts, type: 'msg:deleted', delId: <被删消息的 id> }
   * 墓碑自身占用 id 序列（保证重启后新消息不复用已删除的 id），加载时按墓碑过滤。
   */
  async _loadMessages() {
    const file = path.join(this.dir, MESSAGES_FILE);
    let raw = '';
    try {
      raw = await fsp.readFile(file, 'utf8');
    } catch (_) {
      await fsp.writeFile(file, '', 'utf8');
      return;
    }
    const list = [];
    const deletedIds = new Set();
    let maxId = 0;
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const m = JSON.parse(t);
        if (!m || typeof m.id !== 'number') continue;
        if (m.id > maxId) maxId = m.id;
        if (m.type === 'msg:deleted' && typeof m.delId === 'number') {
          deletedIds.add(m.delId);
        } else {
          list.push(m);
        }
      } catch (_) { /* 跳过损坏行，不阻塞启动 */ }
    }
    list.sort((a, b) => a.id - b.id);
    this.messages = list.filter((m) => !deletedIds.has(m.id));
    this.seq = maxId;
  }

  /**
   * 追加一条消息并落盘。
   * @param {{type:string,userId:string,name:string,text?:string,image?:object,file?:object}} msg
   */
  addMessage(msg) {
    const full = Object.assign({ id: ++this.seq, ts: Date.now() }, msg);
    this.messages.push(full);
    const line = JSON.stringify(full) + '\n';
    this._chain = this._chain
      .then(() => fsp.appendFile(path.join(this.dir, MESSAGES_FILE), line, 'utf8'))
      .catch((e) => console.error('[store] 写入消息失败:', e.message));
    return full;
  }

  /** 按 id 查找消息（messages 按 id 升序，二分） */
  getMessage(id) {
    let lo = 0, hi = this.messages.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.messages[mid].id < id) lo = mid + 1;
      else hi = mid;
    }
    const m = this.messages[lo];
    return m && m.id === id ? m : null;
  }

  /**
   * 删除一条消息：内存移除 + 追加墓碑行落盘（append-only，不重写文件）。
   * 返回被删的消息，供调用方清理其引用的服务端文件；不存在返回 null。
   */
  deleteMessage(id) {
    const idx = this.messages.findIndex((m) => m.id === id);
    if (idx === -1) return null;
    const [removed] = this.messages.splice(idx, 1);
    const tomb = { id: ++this.seq, ts: Date.now(), type: 'msg:deleted', delId: removed.id };
    const line = JSON.stringify(tomb) + '\n';
    this._chain = this._chain
      .then(() => fsp.appendFile(path.join(this.dir, MESSAGES_FILE), line, 'utf8'))
      .catch((e) => console.error('[store] 写入删除记录失败:', e.message));
    return removed;
  }

  /**
   * 取最近一页历史（正序返回）。before 为空表示取最新一页。
   */
  recent(limit, before) {
    let end = this.messages.length;
    if (typeof before === 'number') {
      // 找到第一条 id >= before 的位置
      let lo = 0, hi = this.messages.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this.messages[mid].id < before) lo = mid + 1;
        else hi = mid;
      }
      end = lo;
    }
    const start = Math.max(0, end - limit);
    const slice = this.messages.slice(start, end);
    return { messages: slice, hasMore: start > 0 };
  }

  /* ---------------- 待发送的图片 ---------------- */

  addPendingUpload(fileId, info) {
    this.pendingUploads.set(fileId, Object.assign({ ts: Date.now() }, info));
  }

  takePendingUpload(fileId, userId) {
    const info = this.pendingUploads.get(fileId);
    if (!info || info.userId !== userId) return null;
    this.pendingUploads.delete(fileId);
    return info;
  }

  /* ---------------- 聊天文件（暂存，到期清理） ---------------- */

  addPendingFile(fileId, info) {
    this.pendingFiles.set(fileId, Object.assign({ ts: Date.now() }, info));
  }

  /** 只查看 pending 文件（不消费），供发送前的下载/预览使用 */
  peekPendingFile(fileId) {
    return this.pendingFiles.get(fileId) || null;
  }

  /** 发送成功：从 pending 转入注册表（files.json），此后按 expiresAt 供下载 */
  takePendingFile(fileId, userId) {
    const info = this.pendingFiles.get(fileId);
    if (!info || info.userId !== userId) return null;
    this.pendingFiles.delete(fileId);
    const entry = {
      rel: info.rel,
      name: info.name,
      mime: info.mime,
      size: info.size,
      expiresAt: info.expiresAt,
      uploader: userId,
      ts: info.ts,
    };
    this.files[fileId] = entry;
    this._saveFiles();
    return entry;
  }

  getFile(fileId) {
    return this.files[fileId] || null;
  }

  /** 从注册表移除文件条目并写盘，返回被移除的条目（供调用方删磁盘文件）；不存在返回 null */
  removeFile(fileId) {
    const entry = this.files[fileId];
    if (!entry) return null;
    delete this.files[fileId];
    this._saveFiles();
    return entry;
  }

  absFile(entry) {
    return path.join(this.fileDir, path.normalize(entry.rel).replace(/^(\.\.[\/\\])+/, ''));
  }

  async _loadFiles() {
    try {
      const raw = JSON.parse(await fsp.readFile(path.join(this.dir, FILES_FILE), 'utf8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) this.files = raw;
    } catch (_) {
      this.files = {};
    }
    // 启动即清一轮，处理上次运行遗留的过期文件
    await this._gcFilesOnce(Date.now());
  }

  _saveFiles() {
    if (this._fileSaveTimer) return;
    this._fileSaveTimer = setTimeout(() => {
      this._fileSaveTimer = null;
      this._writeFilesNow().catch((e) => console.error('[store] 保存文件注册表失败:', e.message));
    }, 500);
  }

  async _writeFilesNow() {
    const file = path.join(this.dir, FILES_FILE);
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(this.files, null, 2), 'utf8');
    await fsp.rename(tmp, file);
  }

  /**
   * 清理过期文件：
   * 1) 扫描 files/YYYYMM/ 磁盘目录 —— 文件名为 `${fileId}-${expiresAt}${ext}`，
   *    过期时间直接编码在文件名里，即使注册表丢失/损坏也能兜底清理；
   * 2) 同步注册表：删除其中已过期的条目；
   * 3) 上传后超过 30 分钟仍未发送的孤儿文件一并删除。
   */
  async _gcFilesOnce(now) {
    const dead = [];

    // 1) 磁盘扫描（权威依据：文件名里的 expiresAt）
    try {
      const subs = await fsp.readdir(this.fileDir, { withFileTypes: true });
      for (const ent of subs) {
        if (!ent.isDirectory()) continue;
        const sub = path.join(this.fileDir, ent.name);
        const names = await fsp.readdir(sub);
        for (const fname of names) {
          const m = /^(.+)-(\d{10,})\.[^.]+$/.exec(fname);
          if (m && Number(m[2]) < now) {
            await fsp.rm(path.join(sub, fname), { force: true });
            dead.push(m[1]);
          }
        }
      }
    } catch (e) {
      console.error('[store] 扫描过期文件失败:', e.message);
    }

    // 2) 注册表过期条目（覆盖 rel 不在当月子目录等边缘情况）
    let dirty = false;
    for (const [id, f] of Object.entries(this.files)) {
      if (f.expiresAt < now || dead.includes(id)) {
        delete this.files[id];
        dirty = true;
        if (!dead.includes(id)) {
          try { await fsp.rm(this.absFile(f), { force: true }); } catch (_) { /* 忽略 */ }
        }
      }
    }

    // 3) 已上传但一直没发出去的孤儿文件
    const orphanDeadline = now - 30 * 60 * 1000;
    for (const [id, info] of this.pendingFiles) {
      if (info.ts < orphanDeadline || info.expiresAt < now) {
        this.pendingFiles.delete(id);
        dead.push(id);
        const abs = path.join(this.fileDir, path.normalize(info.rel).replace(/^(\.\.[\/\\])+/, ''));
        try { await fsp.rm(abs, { force: true }); } catch (_) { /* 忽略 */ }
      }
    }

    if (dirty) this._saveFiles();
    if (dead.length) console.log(`[store] 已清理 ${dead.length} 个过期文件`);
  }

  _startFileGC() {
    const interval = Math.max(0.02, this.fileGcMinutes) * 60 * 1000;
    const run = () => this._gcFilesOnce(Date.now()).catch((e) => console.error('[store] 文件清理失败:', e.message));
    const timer = setInterval(run, interval);
    timer.unref && timer.unref();
  }

  /** 清理上传了但一直没有发出去的孤儿文件（30 分钟） */
  _startUploadGC() {
    const timer = setInterval(() => {
      const deadline = Date.now() - 30 * 60 * 1000;
      for (const [id, info] of this.pendingUploads) {
        if (info.ts < deadline) {
          this.pendingUploads.delete(id);
          // url 形如 /uploads/YYYYMM/name.ext，保留月份子目录并防路径遍历
          const rel = String(info.url || '').replace(/^\/uploads\//, '').split('/').join(path.sep);
          const abs = path.resolve(this.uploadDir, rel);
          if (abs.startsWith(path.resolve(this.uploadDir) + path.sep)) {
            fs.unlink(abs, () => {});
          }
        }
      }
    }, 10 * 60 * 1000);
    timer.unref && timer.unref();
  }
}

module.exports = Store;
