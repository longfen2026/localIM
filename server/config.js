'use strict';

const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

module.exports = {
  PORT: Number(process.env.PORT || 3000),
  HOST: process.env.HOST || '0.0.0.0',

  // 所有需要持久化的数据都放在这里，Docker 中通过 -v 映射到宿主机
  DATA_DIR,
  UPLOAD_DIR: path.join(DATA_DIR, 'uploads'),
  // 聊天文件（非图片）暂存目录：24 小时过期，由 GC 定时清理
  FILE_DIR: path.join(DATA_DIR, 'files'),

  // 单张图片大小上限（MB）
  MAX_UPLOAD_MB: Number(process.env.MAX_UPLOAD_MB || 10),
  // 单个文件大小上限（MB），0 表示不限（仍受磁盘限制）
  MAX_FILE_MB: Number(process.env.MAX_FILE_MB || 200),
  // 文件有效期（小时），从上传时刻起算，过期后下载返回 410 并被清理
  FILE_TTL_HOURS: Number(process.env.FILE_TTL_HOURS || 24),
  // 过期文件清理的扫描间隔（分钟）
  FILE_GC_MINUTES: Number(process.env.FILE_GC_MINUTES || 10),
  // 每次下发的历史消息条数
  HISTORY_PAGE: Number(process.env.HISTORY_PAGE || 50),
  // 历史消息 HTTP 接口一次最多返回多少条
  MAX_HISTORY: Number(process.env.MAX_HISTORY || 2000),

  COOKIE_USER: 'localim_uid',
  COOKIE_NAME: 'localim_name',
  COOKIE_MAX_AGE: 365 * 24 * 3600 * 1000,

  MAX_NAME_LEN: 24,
  MAX_TEXT_LEN: 4000,

  // 自动派生用户名的前缀：192.168.5.102 → ID102
  NAME_PREFIX: process.env.NAME_PREFIX || 'ID',
  // 是否信任反向代理的 X-Forwarded-For。默认只信任本机/私有网段的代理，
  // 避免局域网内随便伪造一个 XFF 就冒用别人的身份；若前面是公网反代，设为 "true"。
  TRUST_PROXY: process.env.TRUST_PROXY || 'loopback,linklocal,uniquelocal',

  // 频率限制：每 N 毫秒最多 M 条消息
  RATE_WINDOW_MS: 5000,
  RATE_MAX_MSG: 15,
  RATE_MAX_UPLOAD: 20,
};
