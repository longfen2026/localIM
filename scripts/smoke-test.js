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
    setTimeout(() => reject(new Error('WS 连接超时')), 5000);
  });
}

// 一张 1x1 的 PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

(async () => {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR, MAX_UPLOAD_MB: '2' }),
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

  const sent = await new Promise((resolve) => sock.emit('msg:send', { text: '你好，局域网！' }, resolve));
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

  const imgSent = await new Promise((resolve) => sock.emit('msg:send', { fileId: upBody.fileId, text: '像素点' }, resolve));
  check('发送图片消息', !!imgSent.ok && imgSent.message.type === 'image');
  check('图片记录了宽高', imgSent.message.image && imgSent.message.image.w === 1 && imgSent.message.image.h === 1);

  const badType = await fetch(BASE + '/api/upload', {
    method: 'POST',
    headers: Object.assign({}, extraHeaders, { Cookie: cookie }),
    body: (() => { const f = new FormData(); f.append('image', new Blob(['<svg/>'], { type: 'image/svg+xml' }), 'x.svg'); return f; })(),
  });
  check('拒绝非白名单图片类型', badType.status === 415, `status=${badType.status}`);

  /* ---------- 历史与持久化 ---------- */

  const hist = await new Promise((resolve) => sock.emit('history:load', { before: init.messages.length ? init.messages[0].id : 1, limit: 10 }, resolve));
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
