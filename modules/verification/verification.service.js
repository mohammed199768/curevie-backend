/**
 * Identity document and phone verification before ordering (setting "verification").
 *
 * Registered patients verify once: the ID and the verified phone stay on the account for every later
 * order (a new profile phone needs a new code). Guests verify on every order: they upload the ID first
 * (id_document_token) and confirm a code sent to their phone (verification_token), then order.
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const pool = require('../../config/db');
const SettingsRepository = require('../../repositories/SettingsRepository');
const { AppError } = require('../../middlewares/errorHandler');
const { savePrivateFile, deleteStoredFile } = require('../../utils/storage');
const messaging = require('../../utils/messaging');

const settingsRepo = new SettingsRepository(pool);

const CODE_TTL_SECONDS = 10 * 60;
const CODES_PER_WINDOW = 3; // per phone, per CODE_TTL window
const MAX_ATTEMPTS = 5;
const TOKEN_TTL_SECONDS = 30 * 60;
const TOKEN_AUDIENCE = 'phone-verification';
const GUEST_ID_TTL_HOURS = 24;
const JORDAN_MOBILE = /^9627\d{8}$/;

const hashCode = (phone, code) => crypto.createHash('sha256').update(`${phone}:${code}:${process.env.JWT_SECRET}`).digest('hex');

async function requirements() {
  const value = await settingsRepo.get('verification');
  return { require_id: value?.require_id !== false, require_phone: Boolean(value?.require_phone) };
}

function jordanMobile(phone) {
  const normalized = messaging.normalizePhone(phone);
  if (!JORDAN_MOBILE.test(normalized)) {
    throw new AppError('Enter a Jordanian mobile number, e.g. 0791234567', 400, 'INVALID_PHONE');
  }
  return normalized;
}

/** Sends a 6-digit code to the phone. In development (no provider) the code is returned for testing. */
async function requestPhoneCode(phone, ip) {
  const normalized = jordanMobile(phone);
  const { rows: recent } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM phone_verifications
     WHERE phone = $1 AND created_at > NOW() - ($2::int * INTERVAL '1 second')`,
    [normalized, CODE_TTL_SECONDS]
  );
  if (recent[0].count >= CODES_PER_WINDOW) {
    throw new AppError('Too many codes were requested for this number. Try again in a few minutes.', 429, 'TOO_MANY_CODES');
  }

  const code = String(crypto.randomInt(100000, 1000000));
  await pool.query(
    `INSERT INTO phone_verifications (phone, code_hash, expires_at, ip)
     VALUES ($1, $2, NOW() + ($3::int * INTERVAL '1 second'), $4)`,
    [normalized, hashCode(normalized, code), CODE_TTL_SECONDS, ip || null]
  );
  const delivery = await messaging.send('PHONE_CODE', normalized, { code });
  if (delivery.status === 'FAILED') {
    throw new AppError('The code could not be sent. Try again shortly.', 502, 'CODE_NOT_SENT');
  }
  return {
    expires_in: CODE_TTL_SECONDS,
    channel: delivery.channel,
    // Only when nothing can deliver messages and this is not production: lets the flow be tested.
    ...(delivery.channel === 'LOG' && process.env.NODE_ENV !== 'production' ? { dev_code: code } : {}),
  };
}

/**
 * Checks the code. Returns a short-lived token proving the phone (used by guest orders); for a
 * logged-in patient whose profile phone matches, the account is marked as phone-verified.
 */
async function confirmPhoneCode(phone, code, user) {
  const normalized = jordanMobile(phone);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM phone_verifications
       WHERE phone = $1 AND verified_at IS NULL AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [normalized]
    );
    const row = rows[0];
    if (!row) throw new AppError('The code expired. Ask for a new one.', 400, 'CODE_EXPIRED');
    if (row.attempts >= MAX_ATTEMPTS) throw new AppError('Too many wrong attempts. Ask for a new code.', 429, 'TOO_MANY_ATTEMPTS');

    const matches = crypto.timingSafeEqual(Buffer.from(row.code_hash), Buffer.from(hashCode(normalized, String(code))));
    if (!matches) {
      await client.query('UPDATE phone_verifications SET attempts = attempts + 1 WHERE id = $1', [row.id]);
      await client.query('COMMIT');
      throw new AppError('The code is not correct', 400, 'INVALID_CODE');
    }
    await client.query('UPDATE phone_verifications SET verified_at = NOW() WHERE id = $1', [row.id]);

    let accountVerified = false;
    if (user?.role === 'PATIENT') {
      const { rows: patients } = await client.query('SELECT phone FROM patients WHERE id = $1', [user.id]);
      if (patients[0] && messaging.normalizePhone(patients[0].phone) === normalized) {
        await client.query(
          'UPDATE patients SET phone_verified_at = NOW(), phone_verified_number = $2, updated_at = NOW() WHERE id = $1',
          [user.id, normalized]
        );
        accountVerified = true;
      }
    }
    await client.query('COMMIT');
    return {
      verification_token: jwt.sign({ phone: normalized }, process.env.JWT_SECRET, {
        expiresIn: TOKEN_TTL_SECONDS,
        audience: TOKEN_AUDIENCE,
      }),
      expires_in: TOKEN_TTL_SECONDS,
      account_verified: accountVerified,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** True when the token proves this phone number. */
function phoneTokenMatches(token, phone) {
  if (!token) return false;
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET, { audience: TOKEN_AUDIENCE });
    return payload.phone === messaging.normalizePhone(phone);
  } catch (_) {
    return false;
  }
}

/** Stores an ID document: on the patient's account, or as a guest upload claimed by the next order. */
async function saveIdDocument(user, file) {
  const key = await savePrivateFile(file.buffer, { folder: 'id-documents', mimeType: file.mimetype });
  const name = String(file.originalname || '').slice(0, 255);
  try {
    if (user?.role === 'PATIENT') {
      const { rows } = await pool.query(
        `UPDATE patients p
         SET id_document_key = $2, id_document_name = $3, id_document_mime = $4, id_document_uploaded_at = NOW(),
             updated_at = NOW()
         FROM (SELECT id, id_document_key AS old_key FROM patients WHERE id = $1) old
         WHERE p.id = old.id
         RETURNING p.id_document_uploaded_at, old.old_key`,
        [user.id, key, name, file.mimetype]
      );
      if (!rows[0]) throw new AppError('Patient account not found', 404, 'NOT_FOUND');
      if (rows[0].old_key) await deleteStoredFile(rows[0].old_key).catch(() => {});
      return { uploaded_at: rows[0].id_document_uploaded_at };
    }
    const { rows } = await pool.query(
      `INSERT INTO id_document_uploads (file_key, file_name, file_mime, expires_at)
       VALUES ($1, $2, $3, NOW() + ($4::int * INTERVAL '1 hour')) RETURNING id, expires_at`,
      [key, name, file.mimetype, GUEST_ID_TTL_HOURS]
    );
    return { id_document_token: rows[0].id, expires_at: rows[0].expires_at };
  } catch (err) {
    await deleteStoredFile(key).catch(() => {});
    throw err;
  }
}

/** Moves a guest's ID upload onto their new order (inside the order's transaction). */
async function claimGuestIdDocument(client, token, caseId) {
  if (!token) return null;
  const { rows } = await client.query(
    `UPDATE id_document_uploads SET used_at = NOW(), case_id = $2
     WHERE id = $1 AND used_at IS NULL AND expires_at > NOW()
     RETURNING file_key, file_name, file_mime`,
    [token, caseId]
  );
  if (!rows[0]) throw new AppError('Upload the ID document again', 400, 'ID_DOCUMENT_EXPIRED', { missing: ['id_document'] });
  await client.query(
    `UPDATE cases SET guest_id_document_key = $2, guest_id_document_name = $3, guest_id_document_mime = $4
     WHERE id = $1`,
    [caseId, rows[0].file_key, rows[0].file_name, rows[0].file_mime]
  );
  return rows[0];
}

async function patientStatus(patientId, db = pool) {
  const { rows } = await db.query(
    'SELECT phone, phone_verified_at, phone_verified_number, id_document_key, id_document_uploaded_at FROM patients WHERE id = $1',
    [patientId]
  );
  const patient = rows[0];
  if (!patient) throw new AppError('Patient account not found', 404, 'NOT_FOUND');
  return {
    phone: patient.phone,
    phone_verified: Boolean(patient.phone_verified_at)
      && patient.phone_verified_number === messaging.normalizePhone(patient.phone),
    id_document_uploaded: Boolean(patient.id_document_key),
    id_document_uploaded_at: patient.id_document_uploaded_at,
  };
}

/** Throws 403 VERIFICATION_REQUIRED (details.missing) when a patient cannot order yet. */
async function assertPatientCanOrder(client, patientId) {
  const [rules, status] = await Promise.all([requirements(), patientStatus(patientId, client)]);
  const missing = [];
  if (rules.require_id && !status.id_document_uploaded) missing.push('id_document');
  if (rules.require_phone && !status.phone_verified) missing.push('phone');
  if (missing.length) {
    throw new AppError('Verify your identity before ordering', 403, 'VERIFICATION_REQUIRED', { missing });
  }
}

/** Checks and applies a guest's verification for a new order (inside the order's transaction). */
async function applyGuestVerification(client, caseId, { guestPhone, phoneToken, idDocumentToken }) {
  const rules = await requirements();
  const missing = [];
  const phoneOk = phoneTokenMatches(phoneToken, guestPhone);
  if (rules.require_phone && !phoneOk) missing.push('phone');
  if (rules.require_id && !idDocumentToken) missing.push('id_document');
  if (missing.length) {
    throw new AppError('Verify your identity before ordering', 403, 'VERIFICATION_REQUIRED', { missing });
  }
  if (idDocumentToken) await claimGuestIdDocument(client, idDocumentToken, caseId);
  if (phoneOk) await client.query('UPDATE cases SET guest_phone_verified_at = NOW() WHERE id = $1', [caseId]);
}

module.exports = {
  requirements,
  requestPhoneCode,
  confirmPhoneCode,
  phoneTokenMatches,
  saveIdDocument,
  patientStatus,
  assertPatientCanOrder,
  applyGuestVerification,
};
