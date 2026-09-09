'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const MESSAGES_FILE = 'messages.jsonl';
const USERS_FILE = 'users.json';
const SECRET_FILE = '.cookie-secret';

/**
 * 极简持久化层：
 * - 消息：append-only 的 JSONL（每行一条），启动时全量载入内存
 * - 用户：单个 JSON 文件，变更时防抖写回
 * - 图片：直接落盘到 uploads/，只在消息里记录相对路径
 * 全部文件都位于 DATA_DIR（Docker 中映射到宿主机），重启容器数据不丢。
 */
class Store {
  constructor(dataDir) {
    this.dir = dataDir;
    this.uploadDir = path.join(dataDir, 'uploads');
    this.messages = [];
    this.users = {};
    this.seq = 0;
    this.secret = '';
    this.pendingUploads = new Map(); // fileId -> {userId, url, w, h, size, name, ts}
    this._chain = Promise.resolve();
    this._userSaveTimer = null;
  }

  async init() {
    await fsp.mkdir(this.uploadDir, { recursive: true });
    this.secret = await this._loadSecret();
    await this._loadUsers();
    await this._loadMessages();
    this._startUploadGC();
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
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const m = JSON.parse(t);
        if (m && typeof m.id === 'number') list.push(m);
      } catch (_) { /* 跳过损坏行，不阻塞启动 */ }
    }
    list.sort((a, b) => a.id - b.id);
    this.messages = list;
    this.seq = list.length ? list[list.length - 1].id : 0;
  }

  /**
   * 追加一条消息并落盘。
   * @param {{type:string,userId:string,name:string,text?:string,image?:object}} msg
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

  /** 清理上传了但一直没有发出去的孤儿文件（30 分钟） */
  _startUploadGC() {
    const timer = setInterval(() => {
      const deadline = Date.now() - 30 * 60 * 1000;
      for (const [id, info] of this.pendingUploads) {
        if (info.ts < deadline) {
          this.pendingUploads.delete(id);
          const abs = path.join(this.uploadDir, path.basename(info.url.replace(/^\/uploads\//, '')));
          fs.unlink(abs, () => {});
        }
      }
    }, 10 * 60 * 1000);
    timer.unref && timer.unref();
  }
}

module.exports = Store;
