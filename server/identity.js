'use strict';

/**
 * 由客户端内网 IP 派生聊天室用户名。
 * 例：192.168.5.102 → 主机号 102 → "ID102"；若 ID102 已被占用，则 ID102-2、ID102-3…
 */

const NAME_PREFIX = process.env.NAME_PREFIX || 'ID';

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 归一化 IP：展开 IPv4-mapped IPv6、去掉 zone id */
function normalizeIp(ip) {
  if (!ip) return '';
  let s = String(ip).trim();
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return mapped[1];
  const pct = s.indexOf('%');
  if (pct > -1) s = s.slice(0, pct);
  return s;
}

/** 取主机号：IPv4 取最后一段，IPv6 取最后一段（16 进制转 10 进制） */
function hostNumber(ip) {
  const s = normalizeIp(ip);
  if (!s) return 0;
  if (s.indexOf(':') > -1) {
    const groups = s.split(':').filter(Boolean);
    const last = groups[groups.length - 1] || '0';
    const n = parseInt(last, 16);
    return Number.isFinite(n) ? n : 0;
  }
  const parts = s.split('.');
  const n = parseInt(parts[parts.length - 1], 10);
  return Number.isFinite(n) ? n : 0;
}

function baseName(ip) {
  return NAME_PREFIX + hostNumber(ip);
}

/** 判断一个名字是否是自动派生出来的（手动改过的名字不会被 IP 变化覆盖） */
function isAutoName(name) {
  return new RegExp('^' + escapeRegExp(NAME_PREFIX) + '\\d+(-\\d+)?$').test(String(name || ''));
}

/**
 * 派生名字。taken 为已被占用的名字集合（Set），冲突时追加 -2、-3…
 */
function deriveName(ip, taken) {
  const base = baseName(ip);
  if (!taken || !taken.has(base)) return base;
  let i = 2;
  while (taken.has(base + '-' + i)) i++;
  return base + '-' + i;
}

module.exports = { NAME_PREFIX, normalizeIp, hostNumber, baseName, isAutoName, deriveName };
