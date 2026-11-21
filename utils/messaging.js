/**
 * The two messages Curevie sends to patients: the phone verification code, and the order tracking
 * link. WhatsApp first, SMS when WhatsApp fails or is not configured, otherwise the "log" driver
 * (nothing leaves the server; the message is written to the log and to outbound_messages).
 *
 * WhatsApp (Meta WhatsApp Cloud API), env:
 *   WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID
 *   WHATSAPP_TEMPLATE_CODE      approved AUTHENTICATION template with the code (default curevie_code)
 *   WHATSAPP_TEMPLATE_TRACKING  approved UTILITY template: {{1}} order number, {{2}} link (default curevie_order_link)
 *   WHATSAPP_TEMPLATE_LANG      template language (default ar)
 * SMS (any HTTP gateway that accepts JSON { to, from, text } with a Bearer key), env:
 *   SMS_API_URL, SMS_API_KEY, SMS_SENDER_ID
 *   Adjust sendSms() to the provider chosen (Jordanian gateways differ in field names).
 */
const pool = require('../config/db');
const { logger } = require('./logger');

const GRAPH_API = 'https://graph.facebook.com/v21.0';
const TIMEOUT_MS = 8000;

/** Jordanian numbers in international form without "+": 0791234567 -> 962791234567. */
function normalizePhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0') && digits.length === 10) digits = `962${digits.slice(1)}`;
  if (digits.startsWith('7') && digits.length === 9) digits = `962${digits}`;
  return digits;
}

const whatsappConfigured = () => Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
const smsConfigured = () => Boolean(process.env.SMS_API_URL && process.env.SMS_API_KEY);

/** True when a real channel exists, i.e. phone codes can actually reach people. */
function canDeliver() {
  return whatsappConfigured() || smsConfigured();
}

async function postJson(url, body, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function whatsappPayload(to, kind, params) {
  const language = { code: process.env.WHATSAPP_TEMPLATE_LANG || 'ar' };
  if (kind === 'PHONE_CODE') {
    // Authentication templates take the code in the body and in the copy-code button.
    return {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: process.env.WHATSAPP_TEMPLATE_CODE || 'curevie_code',
        language,
        components: [
          { type: 'body', parameters: [{ type: 'text', text: params.code }] },
          { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: params.code }] },
        ],
      },
    };
  }
  return {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: process.env.WHATSAPP_TEMPLATE_TRACKING || 'curevie_order_link',
      language,
      components: [{
        type: 'body',
        parameters: [{ type: 'text', text: params.reference }, { type: 'text', text: params.link }],
      }],
    },
  };
}

function smsText(kind, params) {
  return kind === 'PHONE_CODE'
    ? `رمز التحقق من كيورفي: ${params.code}. صالح لمدة 10 دقائق.`
    : `طلبك من كيورفي #${params.reference} تم استلامه. تابع طلبك من هنا: ${params.link}`;
}

async function sendWhatsapp(to, kind, params) {
  const data = await postJson(
    `${GRAPH_API}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    whatsappPayload(to, kind, params),
    { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` }
  );
  return data?.messages?.[0]?.id || null;
}

async function sendSms(to, kind, params) {
  const data = await postJson(
    process.env.SMS_API_URL,
    { to, from: process.env.SMS_SENDER_ID || 'Curevie', text: smsText(kind, params) },
    { Authorization: `Bearer ${process.env.SMS_API_KEY}` }
  );
  return data?.id || data?.message_id || null;
}

async function record(entry) {
  await pool.query(
    `INSERT INTO outbound_messages (kind, channel, recipient, status, provider_message_id, error, case_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [entry.kind, entry.channel, entry.recipient, entry.status, entry.providerMessageId || null,
      entry.error ? String(entry.error).slice(0, 1000) : null, entry.caseId || null]
  ).catch((err) => logger.warn('MESSAGE_LOG_FAILED', { message: err.message }));
}

/**
 * Sends one message; never throws. Returns { channel, status } of the attempt that counted.
 * @param {'PHONE_CODE'|'ORDER_TRACKING'} kind
 * @param {string} phone      any format; normalised here
 * @param {{ code?, reference?, link? }} params
 * @param {{ caseId? }} [context]
 */
async function send(kind, phone, params, { caseId } = {}) {
  const to = normalizePhone(phone);
  const attempts = [
    whatsappConfigured() && { channel: 'WHATSAPP', run: () => sendWhatsapp(to, kind, params) },
    smsConfigured() && { channel: 'SMS', run: () => sendSms(to, kind, params) },
  ].filter(Boolean);

  for (const attempt of attempts) {
    try {
      const providerMessageId = await attempt.run();
      await record({ kind, channel: attempt.channel, recipient: to, status: 'SENT', providerMessageId, caseId });
      return { channel: attempt.channel, status: 'SENT' };
    } catch (err) {
      logger.warn('MESSAGE_SEND_FAILED', { kind, channel: attempt.channel, message: err.message });
      await record({ kind, channel: attempt.channel, recipient: to, status: 'FAILED', error: err.message, caseId });
    }
  }

  if (attempts.length) return { channel: attempts[attempts.length - 1].channel, status: 'FAILED' };
  // No provider configured: the code is never written to the log.
  logger.info('MESSAGE_LOGGED', { kind, to, reference: params.reference, link: params.link });
  await record({ kind, channel: 'LOG', recipient: to, status: 'LOGGED', caseId });
  return { channel: 'LOG', status: 'LOGGED' };
}

async function listForCase(caseId) {
  const { rows } = await pool.query(
    `SELECT id, kind, channel, recipient, status, error, created_at
     FROM outbound_messages WHERE case_id = $1 ORDER BY created_at DESC`,
    [caseId]
  );
  return rows;
}

module.exports = { send, canDeliver, normalizePhone, listForCase };
