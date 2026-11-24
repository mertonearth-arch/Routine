'use strict';
// Formatting and escaping helpers shared by the view model and the page.

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '')) ? esc(u) : '');
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function big(v) {
  if (!isNum(v)) return null;
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (a >= 1e3) return Math.round(v / 1e3) + 'K';
  return String(Math.round(v));
}
const pct = (v) => (isNum(v) ? (v > 0 ? '+' : '') + v.toFixed(1) + '%' : null);
const money = (v) => (isNum(v) ? '$' + big(v) : null);
const price = (v) => (isNum(v) ? '$' + (v >= 1 ? v.toFixed(2) : v.toFixed(4)) : null);

const ET = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const ET_TIME = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const ET_DOW = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' });
const et = (iso) => (iso ? ET.format(new Date(iso)).replace(',', '') + ' ET' : '');
const etTime = (iso) => (iso ? ET_TIME.format(new Date(iso)) + ' ET' : '');
const etDow = (iso) => (iso ? ET_DOW.format(new Date(iso)).toUpperCase() : '');

module.exports = { esc, safeUrl, isNum, big, pct, money, price, et, etTime, etDow };
