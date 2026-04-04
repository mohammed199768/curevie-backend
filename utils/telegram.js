const https = require('https');
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
function isConfigured() {
  return Boolean(BOT_TOKEN && CHAT_ID);
}
function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function sendTelegram(message) {
  if (!isConfigured()) return;
  const body = JSON.stringify({ chat_id: CHAT_ID, text: message, parse_mode: 'HTML' });
  const options = {
    hostname: 'api.telegram.org',
    path: `/bot${BOT_TOKEN}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  };
  const req = https.request(options, (res) => { res.resume(); });
  req.on('error', () => {});
  req.setTimeout(5000, () => { req.destroy(); });
  req.write(body);
  req.end();
}
function alertError(err, req) {
  const path = req ? `${req.method} ${req.path}` : 'unknown';
  const userId = req?.user?.id || 'unauthenticated';
  const message = ['🔴 <b>Server Error</b>', `<b>Path:</b> ${escapeHtml(path)}`, `<b>User:</b> ${escapeHtml(String(userId))}`, `<b>Error:</b> ${escapeHtml(err?.message || String(err))}`, `<b>Time:</b> ${new Date().toISOString()}`].join('\n');
  sendTelegram(message);
}
function alertSlowQuery(sql, durationMs) {
  const shortSql = String(sql || '').slice(0, 200);
  const message = ['🟡 <b>Slow Query</b>', `<b>Duration:</b> ${durationMs}ms`, `<b>SQL:</b> <code>${escapeHtml(shortSql)}</code>`, `<b>Time:</b> ${new Date().toISOString()}`].join('\n');
  sendTelegram(message);
}
function alertStartup(port) {
  sendTelegram(`🟢 <b>Curevie Backend Started</b>\nPort: ${port}\nTime: ${new Date().toISOString()}`);
}
function alertShutdown(reason) {
  sendTelegram(`🔴 <b>Curevie Backend Shutting Down</b>\nReason: ${escapeHtml(String(reason || 'unknown'))}\nTime: ${new Date().toISOString()}`);
}
module.exports = { sendTelegram, alertError, alertSlowQuery, alertStartup, alertShutdown };
