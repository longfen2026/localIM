/* localIM 前端：登录 / 收发文字与图片 / 历史消息 / 在线成员 */
'use strict';

(function () {
  const $ = (id) => document.getElementById(id);

  const el = {
    loginView: $('loginView'), chatView: $('chatView'),
    loginForm: $('loginForm'), nameInput: $('nameInput'), loginErr: $('loginErr'), loginBtn: $('loginBtn'), ipHint: $('ipHint'),
    msgs: $('msgs'), msgList: $('msgList'), loadMore: $('loadMore'), loadMoreBtn: $('loadMoreBtn'),
    jumpLatest: $('jumpLatest'),
    input: $('input'), sendBtn: $('sendBtn'), fileInput: $('fileInput'), imageBtn: $('imageBtn'),
    fileBtn: $('fileBtn'), anyFileInput: $('anyFileInput'),
    emojiBtn: $('emojiBtn'), emojiPop: $('emojiPop'),
    preview: $('preview'), previewImg: $('previewImg'), previewName: $('previewName'), previewDel: $('previewDel'),
    meName: $('meName'), meAvatar: $('meAvatar'), meChip: $('meChip'), logoutBtn: $('logoutBtn'),
    onlineCount: $('onlineCount'), roomSub: document.querySelector('.room-sub'),
    membersBtn: $('membersBtn'), membersPanel: $('membersPanel'), membersList: $('membersList'), membersClose: $('membersClose'),
    themeBtn: $('themeBtn'), themeIcon: $('themeIcon'),
    lightbox: $('lightbox'), lightboxImg: $('lightboxImg'),
    dropHint: $('dropHint'), toast: $('toast'),
  };

  const EMOJIS = ('😀 😄 😁 😂 🤣 😊 😍 😘 😎 🤔 😅 😭 😉 😴 🤝 👍 👏 🙏 💪 ' +
    '❤️ 🔥 ✨ 🎉 🌸 🍀 ☕ 🍺 🍜 🚀 💡 ✅ ⚠️ 🌙 ☀️ 🌈 🎁 📌 📎 💻 🖥️ 📱 🔧').split(' ');

  const state = {
    me: null,
    msgs: [],            // 已渲染/待渲染的消息（按 id 升序）
    ids: new Set(),
    hasMore: true,
    loadingHistory: false,
    pending: new Map(),  // localId -> {row, file?}
    online: [],
    unread: 0,
    localSeq: 0,
    maxUploadBytes: 10 * 1024 * 1024,  // 图片上限（MB→字节），bootstrap 时以服务端下发的 limits 为准
    maxFileBytes: 200 * 1024 * 1024,   // 文件上限
    fileTtlHours: 24,                  // 文件有效期（提示用）
  };

  let socket = null;

  /* ---------------- 通用工具 ---------------- */

  function toast(msg, ms) {
    el.toast.textContent = msg;
    el.toast.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.toast.classList.add('hidden'), ms || 2200);
  }

  async function api(url, options) {
    const res = await fetch(url, Object.assign({ credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } }, options));
    let data = {};
    try { data = await res.json(); } catch (_) { /* 忽略 */ }
    if (!res.ok) throw new Error(data.error || ('请求失败 (' + res.status + ')'));
    return data;
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  function timeLabel(ts) {
    const d = new Date(ts);
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function dayLabel(ts) {
    const d = new Date(ts), now = new Date();
    const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    if (sameDay) return '今天';
    const y = new Date(now.getTime() - 86400000);
    if (d.getFullYear() === y.getFullYear() && d.getMonth() === y.getMonth() && d.getDate() === y.getDate()) return '昨天';
    return d.getFullYear() === now.getFullYear()
      ? d.getMonth() + 1 + '月' + d.getDate() + '日'
      : d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  function dayKey(ts) {
    const d = new Date(ts);
    return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
  }

  function hueOf(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
    return h;
  }

  function initialOf(name) {
    const s = String(name || '?').trim();
    return (s[0] || '?').toUpperCase();
  }

  function buildAvatar(userId, name) {
    const a = document.createElement('div');
    a.className = 'avatar';
    a.style.background = 'hsl(' + hueOf(userId || name) + ' 62% 55%)';
    a.textContent = initialOf(name);
    return a;
  }

  function linkify(target, text) {
    const re = /(https?:\/\/[^\s<>"')]+)/g;
    let last = 0, m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) target.appendChild(document.createTextNode(text.slice(last, m.index)));
      const a = document.createElement('a');
      a.href = m[1];
      a.textContent = m[1];
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      target.appendChild(a);
      last = m.index + m[1].length;
    }
    if (last < text.length) target.appendChild(document.createTextNode(text.slice(last)));
  }

  function formatSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1).replace(/\.0$/, '') + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1).replace(/\.0$/, '') + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  /** 扩展名 → 文件卡片图标（用首字母区分类型，够轻量） */
  function fileBadge(name) {
    const m = /\.([A-Za-z0-9]+)$/.exec(String(name || ''));
    return (m ? m[1].toUpperCase().slice(0, 3) : 'FILE');
  }

  /* ---------------- 消息渲染 ---------------- */

  function makeRow(msg, prev) {
    const isMe = state.me && msg.userId === state.me.id;
    const grouped = !!prev && prev.type !== 'sys' && msg.type !== 'sys' &&
      prev.userId === msg.userId && dayKey(prev.ts) === dayKey(msg.ts) &&
      (msg.ts - prev.ts) < 5 * 60 * 1000;

    const row = document.createElement('div');
    row.className = 'row' + (isMe ? ' me' : '') + (grouped ? ' grouped' : '');
    row.dataset.id = msg.id;

    row.appendChild(buildAvatar(msg.userId, msg.name));

    const body = document.createElement('div');
    body.className = 'body';

    if (!grouped) {
      const sender = document.createElement('div');
      sender.className = 'sender';
      const nm = document.createElement('b');
      nm.textContent = msg.name;
      const t = document.createElement('span');
      t.className = 't';
      t.textContent = timeLabel(msg.ts);
      sender.appendChild(nm);
      sender.appendChild(t);
      body.appendChild(sender);
    }

    const bubble = document.createElement('div');
    bubble.className = 'bubble' + (msg.type === 'image' ? ' img' : '') + (msg.type === 'file' ? ' filecard' : '');

    if (msg.type === 'image' && msg.image) {
      const img = document.createElement('img');
      img.src = msg.image.url;
      img.alt = msg.image.name || '图片';
      if (msg.image.w && msg.image.h) {
        img.width = msg.image.w;
        img.height = msg.image.h;
      }
      img.loading = 'lazy';
      img.addEventListener('click', () => openLightbox(msg.image.url));
      bubble.appendChild(img);
      if (msg.text) {
        const cap = document.createElement('div');
        cap.className = 'cap';
        linkify(cap, msg.text);
        bubble.appendChild(cap);
      }
    } else if (msg.type === 'file' && msg.file) {
      bubble.appendChild(buildFileCard(msg.file));
      if (msg.text) {
        const cap = document.createElement('div');
        cap.className = 'cap';
        linkify(cap, msg.text);
        bubble.appendChild(cap);
      }
    } else {
      linkify(bubble, msg.text || '');
    }

    // 自己已发送的消息（真实 id）可删除
    if (isMe && typeof msg.id === 'number') bubble.appendChild(buildDeleteBtn(msg.id));

    body.appendChild(bubble);
    row.appendChild(body);
    return row;
  }

  /** 删除按钮：hover 气泡右上角出现，确认后删除 */
  function buildDeleteBtn(msgId) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'msg-del';
    b.title = '删除这条消息';
    b.setAttribute('aria-label', '删除这条消息');
    b.textContent = '×';
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!window.confirm('删除这条消息？删除后不可恢复。')) return;
      if (!socket || !socket.connected) { toast('连接已断开，正在重连…'); return; }
      socket.emit('msg:delete', { id: msgId }, (res) => {
        if (!res || res.error) toast((res && res.error) || '删除失败');
        // 成功时由服务端广播 msg:deleted 统一移除（包括自己）
      });
    });
    return b;
  }

  /** 文件消息卡片：图标 + 文件名 + 大小 + 下载；过期则置灰并提示 */
  function buildFileCard(file) {
    const expired = Number(file.expiresAt) < Date.now();
    const card = document.createElement('div');
    card.className = 'file-card' + (expired ? ' expired' : '');

    const badge = document.createElement('span');
    badge.className = 'fc-badge';
    badge.textContent = fileBadge(file.name);

    const info = document.createElement('div');
    info.className = 'fc-info';
    const nm = document.createElement('div');
    nm.className = 'fc-name';
    nm.textContent = file.name || '未命名文件';
    nm.title = file.name || '';
    const meta = document.createElement('div');
    meta.className = 'fc-meta';
    meta.textContent = formatSize(file.size) + (expired ? ' · 文件已过期' : ' · ' + state.fileTtlHours + ' 小时内可下载');
    info.appendChild(nm);
    info.appendChild(meta);

    card.appendChild(badge);
    card.appendChild(info);

    if (!expired) {
      const a = document.createElement('a');
      a.className = 'fc-dl';
      a.href = '/api/files/' + encodeURIComponent(file.id || '');
      a.download = file.name || 'file';
      a.textContent = '下载';
      card.appendChild(a);

      // 到期后自动把卡片置灰为"已过期"（无需刷新页面）
      const delay = Number(file.expiresAt) - Date.now();
      if (delay > 0 && delay < 30 * 24 * 3600 * 1000) {
        setTimeout(() => {
          card.classList.add('expired');
          meta.textContent = formatSize(file.size) + ' · 文件已过期';
          const dl2 = card.querySelector('.fc-dl');
          if (dl2) dl2.remove();
        }, delay + 1000);
      }
    }

    return card;
  }

  function daySepEl(ts) {
    const d = document.createElement('div');
    d.className = 'day-sep';
    const s = document.createElement('span');
    s.textContent = dayLabel(ts);
    d.appendChild(s);
    return d;
  }

  function renderList() {
    el.msgList.textContent = '';
    let prev = null, prevDay = null;
    for (const m of state.msgs) {
      const dk = dayKey(m.ts);
      if (dk !== prevDay) { el.msgList.appendChild(daySepEl(m.ts)); prevDay = dk; prev = null; }
      el.msgList.appendChild(makeRow(m, prev));
      prev = m;
    }
  }

  function renderAll() {
    renderList();
    scrollToBottom(true);
  }

  function appendMessage(msg) {
    if (state.ids.has(msg.id)) return false;
    state.ids.add(msg.id);
    const prev = state.msgs.length ? state.msgs[state.msgs.length - 1] : null;
    state.msgs.push(msg);
    const dk = dayKey(msg.ts);
    if (!prev || dayKey(prev.ts) !== dk) el.msgList.appendChild(daySepEl(msg.ts));
    el.msgList.appendChild(makeRow(msg, prev));
    return true;
  }

  /** 移除一条已渲染的消息（服务端广播删除后调用），保持视觉滚动位置 */
  function removeMessage(id) {
    if (!state.ids.has(id)) return;
    state.ids.delete(id);
    const row = el.msgList.querySelector('.row[data-id="' + id + '"]');
    const h = row ? row.offsetHeight : 0;
    const wasBottom = nearBottom();
    state.msgs = state.msgs.filter((m) => m.id !== id);
    renderList();
    if (!wasBottom && h) {
      // 被删消息在视口上方时内容整体上移，补偿高度差避免视觉跳动
      const prevBehavior = el.msgs.style.scrollBehavior;
      el.msgs.style.scrollBehavior = 'auto';
      el.msgs.scrollTop = Math.max(0, el.msgs.scrollTop - h);
      el.msgs.style.scrollBehavior = prevBehavior;
    }
  }

  function prependMessages(list) {
    if (!list.length) return;
    const oldH = el.msgs.scrollHeight;
    const oldTop = el.msgs.scrollTop;

    for (const m of list) {
      if (state.ids.has(m.id)) continue;
      state.ids.add(m.id);
      state.msgs.push(m);
    }
    state.msgs.sort((a, b) => a.id - b.id);
    renderList();

    // 保持视觉位置：新内容撑高的部分补偿回 scrollTop（临时关掉平滑滚动，避免动画跳动）
    const prevBehavior = el.msgs.style.scrollBehavior;
    el.msgs.style.scrollBehavior = 'auto';
    el.msgs.scrollTop = oldTop + (el.msgs.scrollHeight - oldH);
    el.msgs.style.scrollBehavior = prevBehavior;
  }

  function sysRow(text, ts) {
    const d = document.createElement('div');
    d.className = 'sys-row';
    const s = document.createElement('span');
    s.textContent = text + ' · ' + timeLabel(ts || Date.now());
    d.appendChild(s);
    el.msgList.appendChild(d);
    nearBottom() && scrollToBottom(false);
  }

  function nearBottom() {
    return el.msgs.scrollHeight - el.msgs.scrollTop - el.msgs.clientHeight < 140;
  }

  function scrollToBottom(instant) {
    el.msgs.scrollTo({ top: el.msgs.scrollHeight, behavior: instant ? 'auto' : 'smooth' });
    state.unread = 0;
    el.jumpLatest.classList.add('hidden');
  }

  /* ---------------- 发送 ---------------- */

  function autoResize() {
    el.input.style.height = 'auto';
    el.input.style.height = Math.min(el.input.scrollHeight, 140) + 'px';
  }

  function addPending(msg) {
    const localId = 'p' + (++state.localSeq);
    msg.id = localId;
    const row = makeRow(msg, state.msgs.length ? state.msgs[state.msgs.length - 1] : null);
    row.classList.add('pending');
    el.msgList.appendChild(row);
    state.pending.set(localId, { row });
    scrollToBottom(false);
    return localId;
  }

  function removePending(localId) {
    const p = state.pending.get(localId);
    if (!p) return;
    p.row.remove();
    state.pending.delete(localId);
  }

  function sendText() {
    const text = el.input.value.replace(/\s+$/, '');
    if (!text.trim()) return;
    el.input.value = '';
    autoResize();
    doSend({ text }, null);
  }

  function sendImageFile(file) {
    if (!file) return;
    if (!/^image\/(png|jpeg|gif|webp|bmp)$/.test(file.type)) return toast('只支持 PNG / JPG / GIF / WEBP / BMP 图片');
    if (Number.isFinite(state.maxUploadBytes) && file.size > state.maxUploadBytes) return toast('图片超过 ' + Math.round(state.maxUploadBytes / 1048576) + 'MB，请压缩后再发送');

    const blobUrl = URL.createObjectURL(file);
    const localId = addPending({
      id: 'tmp', type: 'image', userId: state.me.id, name: state.me.name, ts: Date.now(),
      text: '', image: { url: blobUrl, name: file.name },
    });

    uploadImage(file, (percent) => {
      const p = state.pending.get(localId);
      if (p) p.row.style.opacity = String(0.4 + 0.6 * (percent / 100));
    }).then((fileId) => {
      doSend({ fileId, kind: 'image' }, localId, blobUrl);
    }).catch((err) => {
      const p = state.pending.get(localId);
      if (p) { p.row.classList.add('failed'); p.row.style.opacity = '1'; }
      toast(err.message || '图片上传失败');
      setTimeout(() => removePending(localId), 4000);
      URL.revokeObjectURL(blobUrl);
    });
  }

  /** 发送任意文件（非图片）：上传后以文件卡片消息发出 */
  function sendChatFile(file) {
    if (!file) return;
    if (Number.isFinite(state.maxFileBytes) && file.size > state.maxFileBytes) return toast('文件超过 ' + Math.round(state.maxFileBytes / 1048576) + 'MB，无法发送');

    const localId = addPending({
      id: 'tmp', type: 'file', userId: state.me.id, name: state.me.name, ts: Date.now(),
      text: '',
      file: { id: '', name: file.name, size: file.size, mime: file.type, expiresAt: Date.now() + state.fileTtlHours * 3600 * 1000 },
    });

    uploadFile(file, (percent) => {
      const p = state.pending.get(localId);
      if (p) p.row.style.opacity = String(0.4 + 0.6 * (percent / 100));
    }).then((data) => {
      doSend({ fileId: data.fileId, kind: 'file' }, localId);
    }).catch((err) => {
      const p = state.pending.get(localId);
      if (p) { p.row.classList.add('failed'); p.row.style.opacity = '1'; }
      toast(err.message || '文件上传失败');
      setTimeout(() => removePending(localId), 4000);
    });
  }

  function uploadImage(file, onProgress) {
    return uploadFormData('image', file, onProgress);
  }

  function uploadFile(file, onProgress) {
    return uploadFormData('file', file, onProgress);
  }

  function uploadFormData(field, file, onProgress) {
    return new Promise((resolve, reject) => {
      const fd = new FormData();
      fd.append(field, file);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload');
      xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100)); };
      xhr.onload = () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch (_) { /* 忽略 */ }
        if (xhr.status >= 200 && xhr.status < 300 && data.fileId) resolve(data);
        else reject(new Error(data.error || '上传失败'));
      };
      xhr.onerror = () => reject(new Error('网络错误'));
      xhr.send(fd);
    });
  }

  function doSend(payload, localId, blobUrl) {
    if (!socket || !socket.connected) {
      toast('连接已断开，正在重连…');
      return;
    }
    socket.emit('msg:send', payload, (res) => {
      if (!res || res.error) {
        if (localId) {
          const p = state.pending.get(localId);
          if (p) { p.row.classList.remove('pending'); p.row.classList.add('failed'); }
          setTimeout(() => removePending(localId), 4000);
        }
        toast(res && res.error ? res.error : '发送失败');
        return;
      }
      if (localId) { removePending(localId); blobUrl && setTimeout(() => URL.revokeObjectURL(blobUrl), 3000); }
      appendMessage(res.message);
      if (nearBottom()) scrollToBottom(false); else bumpUnread();
    });
  }

  function bumpUnread() {
    state.unread++;
    el.jumpLatest.textContent = '↓ ' + state.unread + ' 条新消息';
    el.jumpLatest.classList.remove('hidden');
  }

  /* ---------------- 在线成员 ---------------- */

  function renderPresence(list) {
    state.online = list || [];
    el.onlineCount.textContent = String(state.online.length);
    el.membersList.textContent = '';
    for (const u of state.online) {
      const li = document.createElement('li');
      const av = document.createElement('div');
      av.className = 'av';
      av.style.background = 'hsl(' + hueOf(u.id) + ' 62% 92%)';
      av.style.color = 'hsl(' + hueOf(u.id) + ' 62% 45%)';
      av.textContent = initialOf(u.name);
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = u.name;
      li.appendChild(av);
      li.appendChild(nm);
      if (state.me && u.id === state.me.id) {
        const tag = document.createElement('span');
        tag.className = 'self';
        tag.textContent = '（我）';
        li.appendChild(tag);
      }
      el.membersList.appendChild(li);
    }
  }

  function setConnState(ok) {
    if (!el.roomSub) return;
    el.roomSub.innerHTML = '';
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = ok ? '#35c759' : '#e5484d';
    const txt = document.createElement('span');
    txt.id = 'onlineCount';
    txt.textContent = String(state.online.length);
    const tail = document.createElement('span');
    tail.textContent = ok ? ' 人在线' : ' 人 · 连接已断开';
    el.roomSub.appendChild(dot);
    el.roomSub.appendChild(txt);
    el.roomSub.appendChild(tail);
    el.onlineCount = txt;
  }

  /* ---------------- 连接 ---------------- */

  function connect() {
    socket = io({ transports: ['websocket', 'polling'] });

    socket.on('connect', () => setConnState(true));
    socket.on('disconnect', () => setConnState(false));
    socket.on('connect_error', (e) => {
      setConnState(false);
      if (e && e.message === 'UNAUTHORIZED') goLogin();
    });

    socket.on('init', (data) => {
      state.me = data.me;
      state.msgs = data.messages || [];
      state.ids = new Set(state.msgs.map((m) => m.id));
      state.hasMore = !!data.hasMore;
      el.loadMore.classList.toggle('hidden', !state.hasMore);
      applyMe();
      renderAll();
      renderPresence(data.online);
      setConnState(true);
    });

    socket.on('msg:new', (msg) => {
      const added = appendMessage(msg);
      if (!added) return;
      if (nearBottom()) scrollToBottom(false);
      else if (msg.userId !== (state.me && state.me.id)) bumpUnread();
    });

    // 服务端已删除该消息（含发起者本人），全员移除
    socket.on('msg:deleted', (data) => {
      const id = Number(data && data.id);
      if (Number.isInteger(id)) removeMessage(id);
    });

    socket.on('sys', (data) => sysRow(data.text, data.ts));
    socket.on('presence', (data) => renderPresence(data.online));
  }

  function disconnect() {
    if (socket) { socket.removeAllListeners(); socket.disconnect(); socket = null; }
  }

  /* ---------------- 登录 / 登出 ---------------- */

  function applyMe() {
    el.meName.textContent = state.me.name;
    el.meAvatar.textContent = initialOf(state.me.name);
    el.meAvatar.style.background = 'hsl(' + hueOf(state.me.id) + ' 62% 55%)';
  }

  function showChat() {
    el.loginView.classList.add('hidden');
    el.chatView.classList.remove('hidden');
    el.input.focus();
  }

  function goLogin() {
    disconnect();
    state.msgs = [];
    state.ids = new Set();
    state.me = null;
    el.msgList.textContent = '';
    el.chatView.classList.add('hidden');
    el.loginView.classList.remove('hidden');
    el.nameInput.focus();
  }

  function setIpHint(ip) {
    el.ipHint.textContent = ip ? '检测到内网地址 ' + ip + '，已自动生成用户名' : '';
  }

  /** 服务端下发的上传上限（图片/文件大小、文件有效期），保持两端一致；0 表示不限 */
  function applyLimits(limits) {
    if (!limits) return;
    const im = Number(limits.maxImageMB);
    const fm = Number(limits.maxFileMB);
    if (Number.isFinite(im)) state.maxUploadBytes = im > 0 ? im * 1048576 : Infinity;
    if (Number.isFinite(fm)) state.maxFileBytes = fm > 0 ? fm * 1048576 : Infinity;
    if (Number.isFinite(Number(limits.fileTtlHours))) state.fileTtlHours = Number(limits.fileTtlHours);
  }

  async function bootstrap() {
    try {
      const data = await api('/api/me');
      applyLimits(data.limits);
      if (data.user) {
        state.me = data.user;
        applyMe();
        showChat();
        connect();
      } else {
        goLogin();
        // 服务端按内网 IP 派生好名字，直接预填，用户可改
        el.nameInput.value = data.suggestedName || '';
        setIpHint(data.ip);
      }
    } catch (_) {
      toast('无法连接服务器');
      goLogin();
    }
  }

  el.loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    // 留空则由服务端按内网 IP 自动派生（192.168.5.102 → ID102）
    const name = el.nameInput.value.trim();
    el.loginErr.textContent = '';
    el.loginBtn.disabled = true;
    try {
      const data = await api('/api/login', { method: 'POST', body: JSON.stringify({ name }) });
      state.me = data.user;
      applyLimits(data.limits);
      applyMe();
      showChat();
      connect();
    } catch (err) {
      el.loginErr.textContent = err.message;
    } finally {
      el.loginBtn.disabled = false;
    }
  });

  el.logoutBtn.addEventListener('click', async () => {
    try { await api('/api/logout', { method: 'POST' }); } catch (_) { /* 忽略 */ }
    goLogin();
    el.nameInput.value = '';
    setIpHint('');
    try {
      const d = await api('/api/me');
      if (!d.user) {
        el.nameInput.value = d.suggestedName || '';
        setIpHint(d.ip);
      }
    } catch (_) { /* 忽略 */ }
  });

  el.meChip.addEventListener('click', async () => {
    const name = window.prompt('修改显示的名字（留空则恢复为按内网地址自动生成的名字）', state.me ? state.me.name : '');
    if (name === null) return;
    const clean = name.trim().slice(0, 24);
    if (clean === (state.me && state.me.name)) return;
    try {
      const data = await api('/api/login', { method: 'POST', body: JSON.stringify({ name: clean }) });
      state.me = data.user;
      applyMe();
      toast('已更新名字');
    } catch (err) { toast(err.message); }
  });

  /* ---------------- 交互绑定 ---------------- */

  el.sendBtn.addEventListener('click', sendText);

  el.input.addEventListener('input', autoResize);
  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !e.repeat) {
      e.preventDefault();
      sendText();
    }
  });

  el.imageBtn.addEventListener('click', () => el.fileInput.click());
  el.fileInput.addEventListener('change', () => {
    const f = el.fileInput.files && el.fileInput.files[0];
    if (f) sendImageFile(f);
    el.fileInput.value = '';
  });

  el.fileBtn.addEventListener('click', () => el.anyFileInput.click());
  el.anyFileInput.addEventListener('change', () => {
    const f = el.anyFileInput.files && el.anyFileInput.files[0];
    if (f) sendChatFile(f);
    el.anyFileInput.value = '';
  });

  // 粘贴：图片走图片流程，其他文件走文件流程
  el.input.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const it of items) {
      if (it.kind === 'file') {
        const f = it.getAsFile();
        if (!f) continue;
        e.preventDefault();
        if (/^image\/(png|jpeg|gif|webp|bmp)$/.test(f.type)) sendImageFile(f);
        else sendChatFile(f);
        return;
      }
    }
  });

  // 拖拽：图片走图片流程，其他文件走文件流程
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!state.me) return;
    e.preventDefault();
    dragDepth++;
    el.dropHint.classList.add('on');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) el.dropHint.classList.remove('on');
  });
  window.addEventListener('drop', (e) => {
    if (!state.me) return;
    e.preventDefault();
    dragDepth = 0;
    el.dropHint.classList.remove('on');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    if (/^image\/(png|jpeg|gif|webp|bmp)$/.test(f.type)) sendImageFile(f);
    else sendChatFile(f);
  });

  // 表情
  EMOJIS.forEach((em) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = em;
    b.addEventListener('click', () => {
      const s = el.input.selectionStart, t = el.input.selectionEnd;
      el.input.value = el.input.value.slice(0, s) + em + el.input.value.slice(t);
      el.input.selectionStart = el.input.selectionEnd = s + em.length;
      el.input.focus();
      autoResize();
    });
    el.emojiPop.appendChild(b);
  });
  el.emojiBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    el.emojiPop.classList.toggle('hidden');
  });
  document.addEventListener('click', (e) => {
    if (!el.emojiPop.contains(e.target) && e.target !== el.emojiBtn) el.emojiPop.classList.add('hidden');
    if (!el.membersPanel.contains(e.target) && e.target.closest('#membersBtn') === null) el.membersPanel.classList.add('hidden');
  });

  // 成员面板
  el.membersBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    el.membersPanel.classList.toggle('hidden');
  });
  el.membersClose.addEventListener('click', () => el.membersPanel.classList.add('hidden'));

  // 历史消息：滚动到顶部加载更多
  el.msgs.addEventListener('scroll', () => {
    if (nearBottom() && state.unread) {
      state.unread = 0;
      el.jumpLatest.classList.add('hidden');
    }
    if (el.msgs.scrollTop < 60) loadHistory();
  });
  el.loadMoreBtn.addEventListener('click', loadHistory);
  el.jumpLatest.addEventListener('click', () => scrollToBottom(false));

  function loadHistory() {
    if (state.loadingHistory || !state.hasMore || !state.msgs.length || !socket) return;
    state.loadingHistory = true;
    el.loadMoreBtn.textContent = '加载中…';
    socket.emit('history:load', { before: state.msgs[0].id, limit: 50 }, (res) => {
      state.loadingHistory = false;
      el.loadMoreBtn.textContent = '查看更早的消息';
      if (res && res.ok) {
        prependMessages(res.messages || []);
        state.hasMore = !!res.hasMore;
        el.loadMore.classList.toggle('hidden', !state.hasMore);
      }
    });
  }

  // 灯箱
  function openLightbox(src) {
    el.lightboxImg.src = src;
    el.lightbox.classList.remove('hidden');
  }
  el.lightbox.addEventListener('click', () => el.lightbox.classList.add('hidden'));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') el.lightbox.classList.add('hidden');
  });

  // 主题
  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'dark' ? '#14161c' : '#f6f7f9');
    el.themeIcon.innerHTML = t === 'dark'
      ? '<path d="M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0-5v3m0 14v3M2 12h3m14 0h3M4.9 4.9l2.1 2.1m10 10 2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/>'
      : '<path d="M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9z"/>';
    try { localStorage.setItem('localim_theme', t); } catch (_) { /* 忽略 */ }
  }
  el.themeBtn.addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  });
  try {
    const saved = localStorage.getItem('localim_theme');
    applyTheme(saved || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  } catch (_) { applyTheme('light'); }

  bootstrap();
})();
