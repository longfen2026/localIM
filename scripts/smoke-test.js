/**
 * 冒烟测试：启动服务 → 按 IP 自动命名/免密登录 → 收发文字与图片 → 断线重连验证历史持久化
 * 用法：npm test
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = process.env.SMOKE_PORT || 3999;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'localim-smoke-'));

// 用 X-Forwarded-For 模拟不同的内网客户端（可信代理规则下会生效）
const IP_A = '192.168.5.102';
const IP_B = '192.168.5.200';
let extraHeaders = { 'X-Forwarded-For': IP_A };

let cookie = '';
const results = [];
function check(name, ok, extra) {
  results.push({ name, ok });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  → ' + extra : ''}`);
}

async function req(url, options = {}) {
  const headers = Object.assign({}, extraHeaders, options.headers);
  const jar = options.cookie !== undefined ? options.cookie : cookie;
  if (jar) headers.Cookie = jar;
  if (options.json) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + url, Object.assign({}, options, { headers }));
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const newCookie = setCookie.length ? setCookie.map((c) => c.split(';')[0]).join('; ') : null;
  if (options.cookie === undefined && newCookie) cookie = newCookie;
  const ct = res.headers.get('content-type') || '';
  const body = ct.includes('application/json') ? await res.json() : await res.text();
  return { status: res.status, body, cookie: newCookie };
}

function connect(opts = {}) {
  return new Promise((resolve, reject) => {
    const sock = io(BASE, {
      transports: ['websocket'],
      extraHeaders: Object.assign(
        { Cookie: opts.cookie !== undefined ? opts.cookie : cookie },
        extraHeaders,
        opts.headers
      ),
      reconnection: false,
    });
    sock.on('init', (data) => resolve({ sock, data }));
    sock.on('connect_error', (e) => reject(new Error('WS 连接失败: ' + e.message)));
    // 非主动关闭的断线要打出来：reconnection 关闭后掉线会让后续 ack 永远等不到
    sock.on('disconnect', (reason) => {
      if (reason !== 'io client disconnect') console.log(`  [ws] 连接断开: ${reason}`);
    });
    setTimeout(() => reject(new Error('WS 连接超时')), 5000);
  });
}

/**
 * 发送事件并等待服务端 ack。
 * 超时（默认 5 秒）直接抛错并附上 socket 状态，避免丢 ack 时测试永久挂起。
 */
function waitAck(sock, event, payload, ms) {
  const timeout = ms || 5000;
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(
        `${event} 未在 ${timeout}ms 内收到 ack（socket=${sock.connected ? '已连接' : '已断开'}, id=${sock.id || '-'}, payload=${JSON.stringify(payload)})`
      ));
    }, timeout);
    sock.emit(event, payload, (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res);
    });
  });
}

// 一张 1x1 的 PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

(async () => {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR, MAX_UPLOAD_MB: '2', MAX_FILE_MB: '2' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

  const cleanup = () => { try { child.kill(); } catch (_) {} };
  process.on('exit', cleanup);

  let ready = false;
  for (let i = 0; i < 50; i++) {
    try {
      const r = await req('/api/health');
      if (r.status === 200) { ready = true; break; }
    } catch (_) { /* 继续等 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!ready) { console.error('服务未能启动'); cleanup(); process.exit(1); }
  console.log('\n== localIM 冒烟测试 ==\n');

  /* ---------- 按 IP 自动命名 ---------- */

  let r = await req('/api/me');
  check('未登录时 /api/me 返回 null', r.status === 200 && r.body.user === null);
  check('未登录时返回按 IP 派生的名字', r.body.suggestedName === 'ID102', `${r.body.ip} → ${r.body.suggestedName}`);

  // 名字留空 → 服务端自动派生
  r = await req('/api/login', { method: 'POST', json: true, body: JSON.stringify({ name: '' }) });
  check('留空名字自动派生为 ID102', r.status === 200 && r.body.user && r.body.user.name === 'ID102', r.body.user && r.body.user.name);
  check('登录响应下发 Cookie', /localim_uid=/.test(cookie));

  // Cookie 自动登录
  r = await req('/api/me');
  check('携带 Cookie 可自动登录', r.status === 200 && r.body.user && r.body.user.name === 'ID102');

  // WebSocket 连接并收发文字（自动名不会被握手地址改写）
  const { sock, data: init } = await connect();
  check('Socket 鉴权通过并收到 init', !!init.me && Array.isArray(init.messages));
  check('Socket 连接后自动名保持一致', init.me.name === 'ID102', init.me.name);

  const sent = await waitAck(sock, 'msg:send', { text: '你好，局域网！' });
  check('发送文字消息', !!sent.ok && sent.message.text === '你好，局域网！');
  check('消息记录的是自动派生名', sent.message.name === 'ID102', sent.message.name);

  // 同主机号冲突 → 自动加序号
  const rB = await req('/api/login', { method: 'POST', json: true, cookie: null, body: JSON.stringify({ name: '' }) });
  check('同 IP 的第二个人自动加序号', rB.body.user && rB.body.user.name === 'ID102-2', rB.body.user && rB.body.user.name);

  // 手动指定名字优先，不被 IP 覆盖
  const rC = await req('/api/login', {
    method: 'POST', json: true, cookie: null,
    headers: { 'X-Forwarded-For': IP_B },
    body: JSON.stringify({ name: '会议室-PC01' }),
  });
  check('手动指定名字不被覆盖', rC.body.user && rC.body.user.name === '会议室-PC01');
  const c3 = await connect({ cookie: rC.cookie, headers: { 'X-Forwarded-For': IP_B } });
  check('Socket 连接也不改写手动名字', c3.data.me.name === '会议室-PC01', c3.data.me.name);
  c3.sock.close();

  /* ---------- 图片 ---------- */

  const fd = new FormData();
  fd.append('image', new Blob([PNG], { type: 'image/png' }), 'px.png');
  const up = await fetch(BASE + '/api/upload', {
    method: 'POST',
    headers: Object.assign({}, extraHeaders, { Cookie: cookie }),
    body: fd,
  });
  const upBody = await up.json();
  check('图片上传成功', up.status === 200 && !!upBody.fileId, `status=${up.status}`);

  const imgSent = await waitAck(sock, 'msg:send', { fileId: upBody.fileId, text: '像素点' });
  check('发送图片消息', !!imgSent.ok && imgSent.message.type === 'image');
  check('图片记录了宽高', imgSent.message.image && imgSent.message.image.w === 1 && imgSent.message.image.h === 1);

  const badType = await fetch(BASE + '/api/upload', {
    method: 'POST',
    headers: Object.assign({}, extraHeaders, { Cookie: cookie }),
    body: (() => { const f = new FormData(); f.append('image', new Blob(['<svg/>'], { type: 'image/svg+xml' }), 'x.svg'); return f; })(),
  });
  check('拒绝非白名单图片类型', badType.status === 415, `status=${badType.status}`);

  /* ---------- 文件发送 ---------- */

  // limits 下发
  r = await req('/api/me');
  check('/api/me 下发上传上限', r.body.limits && r.body.limits.maxImageMB === 2 && r.body.limits.maxFileMB === 2 && r.body.limits.fileTtlHours === 24,
    JSON.stringify(r.body.limits));

  // 上传文本文件
  const fileContent = '本地文件内容 localIM file upload';
  const fdF = new FormData();
  fdF.append('file', new Blob([fileContent], { type: 'text/plain' }), '说明 文档.txt');
  const upF = await fetch(BASE + '/api/upload', {
    method: 'POST',
    headers: Object.assign({}, extraHeaders, { Cookie: cookie }),
    body: fdF,
  });
  const upFBody = await upF.json();
  check('文件上传成功', upF.status === 200 && !!upFBody.fileId && upFBody.kind === 'file', `status=${upF.status}`);

  // 落盘到 files/ 目录，且文件名带过期时间戳
  const fileNamesBefore = fs.readdirSync(path.join(DATA_DIR, 'files'), { recursive: true })
    .filter((f) => String(f).endsWith('.txt'));
  check('文件已落盘到 files/（文件名编码过期时间）',
    fileNamesBefore.length === 1 && /-[0-9]{10,}\.txt$/.test(fileNamesBefore[0]),
    fileNamesBefore.join(','));

  // 通过 WebSocket 发送文件消息
  const fileSent = await waitAck(sock, 'msg:send', { fileId: upFBody.fileId, kind: 'file', text: '见附件' });
  check('发送文件消息', !!fileSent.ok && fileSent.message.type === 'file',
    fileSent.ok ? '' : fileSent.error);
  check('文件消息记录了文件名/大小/过期时间',
    fileSent.message.file && fileSent.message.file.name === '说明 文档.txt' &&
    fileSent.message.file.size === Buffer.byteLength(fileContent) &&
    fileSent.message.file.expiresAt > Date.now());

  // 下载内容一致，响应头为附件
  const dl = await fetch(BASE + '/api/files/' + upFBody.fileId, { headers: extraHeaders });
  const dlText = await dl.text();
  check('按 fileId 下载文件内容一致', dl.status === 200 && dlText === fileContent, `status=${dl.status}`);
  check('下载响应为附件且带 nosniff',
    /attachment/i.test(dl.headers.get('content-disposition') || '') && dl.headers.get('x-content-type-options') === 'nosniff');

  // 不存在的 fileId → 404
  const dl404 = await fetch(BASE + '/api/files/000000000000000000000000', { headers: extraHeaders });
  check('不存在的 fileId 下载返回 404', dl404.status === 404, `status=${dl404.status}`);

  // 同一个 fileId 不能发送两次（发送后从 pending 移除）
  const fdF2 = new FormData();
  fdF2.append('file', new Blob([fileContent], { type: 'text/plain' }), '重复.txt');
  const upF2 = await fetch(BASE + '/api/upload', {
    method: 'POST',
    headers: Object.assign({}, extraHeaders, { Cookie: cookie }),
    body: fdF2,
  });
  const upF2Body = await upF2.json();
  const dupSend = await waitAck(sock, 'msg:send', { fileId: upF2Body.fileId, kind: 'file' });
  const dupSend2 = await waitAck(sock, 'msg:send', { fileId: upF2Body.fileId, kind: 'file' });
  check('同一个 fileId 不能发送两次', !!dupSend.ok && !!dupSend2.error, dupSend2.error);

  // 超过 MAX_FILE_MB 的文件拒绝（实例上限 2MB）
  const fdBig = new FormData();
  fdBig.append('file', new Blob([Buffer.alloc(2 * 1024 * 1024 + 1)], { type: 'application/octet-stream' }), 'big.bin');
  const upBig = await fetch(BASE + '/api/upload', {
    method: 'POST',
    headers: Object.assign({}, extraHeaders, { Cookie: cookie }),
    body: fdBig,
  });
  check('超过大小上限的文件拒绝', upBig.status === 413, `status=${upBig.status}`);

  /* ---------- 文件过期与清理（独立实例：TTL≈1秒，GC 间隔≈1.2秒） ---------- */

  const PORT2 = PORT + 1;
  const DATA2 = fs.mkdtempSync(path.join(os.tmpdir(), 'localim-smoke-files-'));
  const child2 = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(PORT2), DATA_DIR: DATA2,
      FILE_TTL_HOURS: '0.0003',   // ≈ 1 秒
      FILE_GC_MINUTES: '0.02',    // ≈ 1.2 秒
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const cleanup2 = () => { try { child2.kill(); } catch (_) {} };
  process.on('exit', cleanup2);

  const BASE2 = `http://127.0.0.1:${PORT2}`;
  const savedCookie = cookie;
  cookie = '';
  let ready2 = false;
  for (let i = 0; i < 50; i++) {
    try {
      const rr = await fetch(BASE2 + '/api/health');
      if (rr.status === 200) { ready2 = true; break; }
    } catch (_) { /* 继续等 */ }
    await new Promise((r2) => setTimeout(r2, 200));
  }
  if (!ready2) { console.error('过期测试实例未能启动'); cleanup2(); process.exit(1); }

  // 在短 TTL 实例上登录并上传
  const rl = await fetch(BASE2 + '/api/login', {
    method: 'POST',
    headers: Object.assign({}, extraHeaders, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ name: '过期测试员' }),
  });
  cookie = (rl.headers.getSetCookie ? rl.headers.getSetCookie() : []).map((c) => c.split(';')[0]).join('; ');

  const fdE = new FormData();
  fdE.append('file', new Blob(['expires soon'], { type: 'text/plain' }), 'short.txt');
  const upE = await fetch(BASE2 + '/api/upload', {
    method: 'POST',
    headers: Object.assign({}, extraHeaders, { Cookie: cookie }),
    body: fdE,
  });
  const upEBody = await upE.json();
  check('短 TTL 实例上传成功', upE.status === 200 && !!upEBody.fileId, `status=${upE.status}`);

  // 过期前可下载
  const dlNow = await fetch(BASE2 + '/api/files/' + upEBody.fileId, { headers: extraHeaders });
  check('过期前可下载', dlNow.status === 200, `status=${dlNow.status}`);

  // 等待 TTL（≈1s）+ GC 扫描（≈1.2s）过去，文件过期并被清理
  await new Promise((r2) => setTimeout(r2, 4000));
  const dlAfter = await fetch(BASE2 + '/api/files/' + upEBody.fileId, { headers: extraHeaders });
  check('过期后下载返回 410/404', dlAfter.status === 410 || dlAfter.status === 404, `status=${dlAfter.status}`);

  const leftFiles = fs.readdirSync(path.join(DATA2, 'files'), { recursive: true })
    .filter((f) => String(f).endsWith('.txt'));
  check('过期文件已被服务端清理', leftFiles.length === 0, leftFiles.join(','));
  let filesJson = {};
  try { filesJson = JSON.parse(fs.readFileSync(path.join(DATA2, 'files.json'), 'utf8')); } catch (_) {}
  check('注册表中过期条目已移除', Object.keys(filesJson).length === 0, JSON.stringify(Object.keys(filesJson)));

  cleanup2();
  fs.rmSync(DATA2, { recursive: true, force: true });
  cookie = savedCookie;

  /* ---------- 删除自己发送的消息 ---------- */

  // 发一条待删除的文字
  const delMsg = await waitAck(sock, 'msg:send', { text: '这条要被删除' });
  check('发送待删除消息', !!delMsg.ok && typeof delMsg.message.id === 'number');

  // 参数 / 存在性校验
  const delBad = await waitAck(sock, 'msg:delete', { id: 'abc' });
  check('删除参数错误返回错误', !!delBad.error);
  const del404 = await waitAck(sock, 'msg:delete', { id: 99999999 });
  check('删除不存在的消息返回错误', !!del404.error);
  const delTxt = await waitAck(sock, 'msg:delete', { id: delMsg.message.id });
  check('删除自己的文字消息', !!delTxt.ok && delTxt.id === delMsg.message.id);
  const delGone = await waitAck(sock, 'msg:delete', { id: delMsg.message.id });
  check('重复删除同一条消息返回错误', !!delGone.error, delGone.error);

  // 他人消息不可删：ID102-2 的用户删除 ID102 的图片消息
  const sockB = await connect({ cookie: rB.cookie });
  const delForeign = await waitAck(sockB.sock, 'msg:delete', { id: imgSent.message.id });
  check('不能删除他人发送的消息', !!delForeign.error, delForeign.error);
  sockB.sock.close();

  // 删除图片消息 → 服务端图片文件被清理
  const fdDel = new FormData();
  fdDel.append('image', new Blob([PNG], { type: 'image/png' }), 'del.png');
  const upDel = await fetch(BASE + '/api/upload', {
    method: 'POST',
    headers: Object.assign({}, extraHeaders, { Cookie: cookie }),
    body: fdDel,
  });
  const upDelBody = await upDel.json();
  const sentImgDel = await waitAck(sock, 'msg:send', { fileId: upDelBody.fileId });
  const pngBefore = countUploadPng();
  const delImg = await waitAck(sock, 'msg:delete', { id: sentImgDel.message.id });
  await new Promise((r2) => setTimeout(r2, 400));
  check('删除图片消息成功', !!delImg.ok, delImg.error || '');
  check('删除图片消息清理服务端图片文件', countUploadPng() === pngBefore - 1, `${pngBefore} → ${countUploadPng()}`);

  // 删除文件消息 → files 下文件被清理、注册表移除、下载 404
  const fdDelF = new FormData();
  fdDelF.append('file', new Blob(['delete me'], { type: 'text/plain' }), '删除我.txt');
  const upDelF = await fetch(BASE + '/api/upload', {
    method: 'POST',
    headers: Object.assign({}, extraHeaders, { Cookie: cookie }),
    body: fdDelF,
  });
  const upDelFBody = await upDelF.json();
  const sentFileDel = await waitAck(sock, 'msg:send', { fileId: upDelFBody.fileId, kind: 'file' });
  // files.json 为防抖写盘（500ms），等待写盘后再读
  await new Promise((r2) => setTimeout(r2, 900));
  const filesJsonDel = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'files.json'), 'utf8'));
  check('文件消息发送后进入注册表', !!filesJsonDel[upDelFBody.fileId]);
  const filesBeforeDel = countFilesOnDisk('.txt');
  const delFile = await waitAck(sock, 'msg:delete', { id: sentFileDel.message.id });
  await new Promise((r2) => setTimeout(r2, 900));
  check('删除文件消息成功', !!delFile.ok, delFile.error || '');
  check('删除文件消息清理服务端文件', countFilesOnDisk('.txt') === filesBeforeDel - 1, `${filesBeforeDel} → ${countFilesOnDisk('.txt')}`);
  const filesJsonDel2 = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'files.json'), 'utf8'));
  check('注册表中对应条目已移除', !filesJsonDel2[upDelFBody.fileId]);
  const dlDeleted = await fetch(BASE + '/api/files/' + upDelFBody.fileId, { headers: extraHeaders });
  check('已删除文件的下载返回 404', dlDeleted.status === 404, `status=${dlDeleted.status}`);

  // 重连后历史不含已删除消息（墓碑持久化生效）
  const delIds = [delMsg.message.id, sentImgDel.message.id, sentFileDel.message.id];
  const { data: initDel, sock: sockDel } = await connect();
  check('重连后历史不含已删除消息', initDel.messages.every((m) => !delIds.includes(m.id)),
    initDel.messages.map((m) => m.id).join(','));
  sockDel.close();

  /** 统计 uploads/ 下指定扩展名文件数 */
  function countUploadPng() {
    return fs.readdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true }).filter((f) => String(f).endsWith('.png')).length;
  }

  /** 统计 files/ 下指定扩展名文件数 */
  function countFilesOnDisk(ext) {
    return fs.readdirSync(path.join(DATA_DIR, 'files'), { recursive: true }).filter((f) => String(f).endsWith(ext)).length;
  }

  /* ---------- 历史与持久化 ---------- */

  const hist = await waitAck(sock, 'history:load', { before: init.messages.length ? init.messages[0].id : 1, limit: 10 });
  check('历史分页接口可用', !!hist.ok && Array.isArray(hist.messages));

  sock.close();
  await new Promise((r) => setTimeout(r, 300));
  const { data: init2 } = await connect();
  check('重连后仍自动登录', !!init2.me && init2.me.name === 'ID102');
  check('重连后能看到历史消息', init2.messages.length >= 2, `${init2.messages.length} 条`);
  check('历史中包含图片消息', init2.messages.some((m) => m.type === 'image'));

  const onDisk = fs.existsSync(path.join(DATA_DIR, 'messages.jsonl'))
    ? fs.readFileSync(path.join(DATA_DIR, 'messages.jsonl'), 'utf8').trim().split('\n') : [];
  check('消息已持久化到磁盘', onDisk.length >= 2, `${onDisk.length} 行`);
  check('Cookie 密钥已持久化', fs.existsSync(path.join(DATA_DIR, '.cookie-secret')));
  check('图片文件已落盘', fs.readdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true }).some((f) => String(f).endsWith('.png')));

  r = await req('/api/logout', { method: 'POST', json: true });
  check('登出成功', r.status === 200);

  console.log('\n== 结果 ==');
  const failed = results.filter((x) => !x.ok);
  console.log(`${results.length - failed.length}/${results.length} 通过`);
  cleanup();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('\n测试异常:', e);
  process.exit(1);
});
