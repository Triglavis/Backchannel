import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { deviceRevocationTarget, handleAccountDevice, matchAccountDeviceRoute } from './devices.mjs';
import { topicReportSubject, topicReportToken } from './topic-reports.mjs';

const jsonHeaders = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};
const sessionAge = 7 * 24 * 60 * 60 * 1000;
const ceremonyAge = 5 * 60 * 1000;
const unlockAge = 60 * 1000;
const emailCodeAge = 15 * 60 * 1000;
const emailSendInterval = 60 * 1000;
const emailSendLimit = 4;
const emailBudgetWindow = 60 * 60 * 1000;
const defaultHourlyEmailLimit = 120;
const emailCodeAttempts = 5;
const maxCiphertextChars = 1_398_102;
const textEncoder = new TextEncoder();

const reply = (data, status = 200) => Response.json(data, { status, headers: jsonHeaders });
const fail = (error, status) => reply({ error }, status);
const noContent = () => new Response(null, { status: 204, headers: jsonHeaders });
const encodeBytes = bytes => bytes.toBase64({ alphabet: 'base64url', omitPadding: true });
const decodeBytes = value => Uint8Array.fromBase64(value, { alphabet: 'base64url' });
const validSyncVerifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const validSyncSignature = value => typeof value === 'string' && /^[A-Za-z0-9_-]{86}$/.test(value);
const validEnvelope = value => typeof value === 'string' && /^[A-Za-z0-9_-]{80}$/.test(value);

async function verifySyncSignature(publicKey, signature, purpose, ...fields) {
  if (!validSyncVerifier(publicKey) || !validSyncSignature(signature)) return false;
  try {
    const key = await crypto.subtle.importKey('raw', decodeBytes(publicKey), 'Ed25519', false, ['verify']);
    const message = textEncoder.encode(JSON.stringify([purpose, 2, ...fields]));
    return await crypto.subtle.verify('Ed25519', key, decodeBytes(signature), message);
  } catch {
    return false;
  }
}

export async function expireAccountState(db, now = Date.now()) {
  if (!db) return;
  await db.batch([
    db.prepare('DELETE FROM account_email_codes WHERE expires_at <= ?').bind(now),
    db.prepare('DELETE FROM account_email_sends WHERE expires_at <= ? AND window_expires_at <= ?').bind(now, now),
    db.prepare('DELETE FROM account_email_budget WHERE window_start < ?').bind(Math.floor(now / emailBudgetWindow) * emailBudgetWindow),
    db.prepare('DELETE FROM ceremonies WHERE expires_at <= ?').bind(now),
    db.prepare('DELETE FROM account_signups WHERE expires_at <= ?').bind(now),
    db.prepare('DELETE FROM account_unlocks WHERE expires_at <= ?').bind(now),
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now),
  ]);
}

class BodyError extends Error {
  constructor(status) {
    super(status === 413 ? 'request-too-large' : 'invalid-json');
    this.status = status;
  }
}

async function readJSON(request, limit) {
  const contentType = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw new BodyError(400);
  if (Number(request.headers.get('Content-Length')) > limit) throw new BodyError(413);
  const reader = request.body?.getReader();
  if (!reader) throw new BodyError(400);

  const decoder = new TextDecoder();
  let length = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel();
      throw new BodyError(413);
    }
    text += decoder.decode(value, { stream: true });
  }
  try {
    return JSON.parse(text + decoder.decode());
  } catch {
    throw new BodyError(400);
  }
}

const diagnosticOperations = ['account-sync', 'feed', 'discover', 'thread'];
const diagnosticSources = ['hn', 'reddit', 'x', 'bsky', 'lobsters', 'wikipedia', 'hypothesis', 'mastodon', 'lemmy'];
const diagnosticOutcomes = ['ok', 'empty', 'timeout', 'limited', 'unavailable', 'sign-in', 'conflict'];
const diagnosticDurations = [250, 1000, 3000, 10000, 30000, 120000];

async function receiveDiagnostics(request, env, url, ip) {
  const sink = env.BACKCHANNEL_DIAGNOSTICS;
  const limiter = env.ACCOUNT_RATE_LIMIT;
  if (!limiter || typeof sink?.writeDataPoint !== 'function') return fail('diagnostics-unavailable', 503);
  if (url.search || request.headers.has('Authorization')) return fail('invalid-diagnostics', 400);
  if (!(await limiter.limit({ key: 'diagnostics:' + ip })).success) return fail('rate-limited', 429);
  const body = await readJSON(request, 256);
  if (!body || Object.keys(body).length !== 5) return fail('invalid-diagnostics', 400);
  const { operation, source, outcome, duration, version } = body;
  if (!diagnosticOperations.includes(operation) || (operation === 'account-sync' ? source !== '' : !diagnosticSources.includes(source)) ||
      !diagnosticOutcomes.includes(outcome) || !diagnosticDurations.includes(duration) ||
      typeof version !== 'string' || !/^(?:unknown|\d{1,3}(?:\.\d{1,3}){2,3}(?:-(?:alpha|beta|rc)(?:\.\d{1,2})?)?)$/.test(version)) {
    return fail('invalid-diagnostics', 400);
  }
  sink.writeDataPoint({ blobs: [operation, source, outcome, version], doubles: [duration], indexes: [operation + ':' + source] });
  return noContent();
}

async function hashToken(token) {
  return encodeBytes(new Uint8Array(await crypto.subtle.digest('SHA-256', textEncoder.encode(token))));
}

function numericEmailCode() {
  const random = new Uint32Array(1);
  do { crypto.getRandomValues(random); } while (random[0] >= 4_294_000_000);
  return String(random[0] % 1_000_000).padStart(6, '0');
}

async function hashNumericEmailCode(secret, verificationId, code) {
  const key = await crypto.subtle.importKey('raw', textEncoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return encodeBytes(new Uint8Array(await crypto.subtle.sign('HMAC', key, textEncoder.encode(verificationId + ':' + code))));
}

function normalizeEmail(input) {
  if (typeof input !== 'string') return null;
  const email = input.trim().toLowerCase();
  const [local, domain, extra] = email.split('@');
  if (email.length > 254 || !domain || extra !== undefined || local.length > 64 ||
      !/^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+$/.test(local) || local.startsWith('.') ||
      local.endsWith('.') || local.includes('..') ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain)) return null;
  return email;
}

async function sendEmailCode(env, kind, email, auth, format, continuation = null) {
  const db = env.ACCOUNTS_DB;
  const emailHash = await hashToken(email);
  const now = Date.now();
  const [, reserved] = await db.batch([
    db.prepare('DELETE FROM account_email_sends WHERE kind = ? AND email_hash = ? AND expires_at <= ? AND window_expires_at <= ?')
      .bind(kind, emailHash, now, now),
    db.prepare(`
      INSERT INTO account_email_sends (kind, email_hash, expires_at, send_count, window_expires_at)
      VALUES (?, ?, ?, 1, ?)
      ON CONFLICT (kind, email_hash) DO UPDATE SET expires_at = excluded.expires_at, send_count = send_count + 1
      WHERE expires_at <= ? AND send_count < ?
      RETURNING expires_at, send_count, window_expires_at
    `).bind(kind, emailHash, now + emailSendInterval, now + emailCodeAge, now, emailSendLimit),
  ]);
  const budget = reserved.results[0];
  if (!budget) {
    const last = await db.prepare('SELECT expires_at, send_count, window_expires_at FROM account_email_sends WHERE kind = ? AND email_hash = ?').bind(kind, emailHash).first();
    if (!last) return fail('rate-limited', 429);
    const remainingResends = emailSendLimit - last.send_count;
    const until = remainingResends ? last.expires_at : Math.max(last.expires_at, last.window_expires_at);
    return reply({ error: 'rate-limited', retryAfter: Math.max(1, Math.ceil((until - now) / 1000)), remainingResends }, 429);
  }

  const numeric = format === 'numeric' && Boolean(env.ACCOUNT_EMAIL_CODE_SECRET);
  const verificationId = numeric ? continuation?.verificationId ?? encodeBytes(crypto.getRandomValues(new Uint8Array(16))) : null;
  const code = numeric ? numericEmailCode() : encodeBytes(crypto.getRandomValues(new Uint8Array(16)));
  const codeHash = numeric ? await hashNumericEmailCode(env.ACCOUNT_EMAIL_CODE_SECRET, verificationId, code) : await hashToken(code);
  const expiresAt = now + emailCodeAge;
  let query;
  if (kind === 'recover') {
    query = db.prepare(`
      INSERT INTO account_email_codes (code_hash, kind, email_hash, account_id, recovery_epoch, expires_at)
      SELECT ?, ?, ?, id, recovery_epoch, ? FROM accounts WHERE recovery_email = ?
    `).bind(codeHash, kind, emailHash, expiresAt, email);
  } else if (auth) {
    query = db.prepare(`
      INSERT INTO account_email_codes (code_hash, kind, email_hash, account_id, recovery_epoch, session_hash, expires_at)
      SELECT ?, ?, ?, accounts.id, accounts.recovery_epoch, sessions.token_hash, ?
      FROM accounts JOIN sessions ON sessions.account_id = accounts.id
      WHERE sessions.token_hash = ? AND sessions.expires_at > ?
    `).bind(codeHash, kind, emailHash, expiresAt, auth.tokenHash, Date.now());
  } else {
    query = db.prepare(`
      INSERT INTO account_email_codes (code_hash, kind, email_hash, expires_at) VALUES (?, ?, ?, ?)
    `).bind(codeHash, kind, emailHash, expiresAt);
  }
  const writes = [query];
  if (verificationId) writes.push(db.prepare('UPDATE account_email_codes SET verification_id = ? WHERE code_hash = ?').bind(verificationId, codeHash));
  const [stored] = await db.batch(writes);
  if (!stored.meta.changes) return auth ? fail('sign-in-required', 401) : reply({ ok: true });

  const admissionTime = Date.now();
  const windowStart = Math.floor(admissionTime / emailBudgetWindow) * emailBudgetWindow;
  const hourlyLimit = Number(env.ACCOUNT_EMAIL_HOURLY_LIMIT ?? defaultHourlyEmailLimit);
  const enrollmentLimit = Number(env.ACCOUNT_EMAIL_ENROLLMENT_HOURLY_LIMIT ?? hourlyLimit);
  const enrollment = kind === 'register' && (!continuation || !await db.prepare('SELECT 1 FROM accounts WHERE recovery_email = ?').bind(email).first());
  const admitted = await db.prepare(`
    INSERT INTO account_email_budget (window_start, send_count, enrollment_count) VALUES (?, 1, ?)
    ON CONFLICT (window_start) DO UPDATE SET send_count = send_count + 1, enrollment_count = enrollment_count + excluded.enrollment_count
    WHERE send_count < ? AND (excluded.enrollment_count = 0 OR enrollment_count < ?)
    RETURNING send_count
  `).bind(windowStart, Number(enrollment), hourlyLimit, enrollmentLimit).first();
  if (!admitted) {
    await db.prepare('DELETE FROM account_email_codes WHERE code_hash = ?').bind(codeHash).run();
    const retryAfter = Math.ceil((windowStart + emailBudgetWindow - admissionTime) / 1000);
    const response = reply({ error: 'rate-limited', retryAfter }, 429);
    response.headers.set('Retry-After', String(retryAfter));
    return response;
  }

  try {
    const action = kind === 'recover' ? 'replace your Backchannel passkey' : 'verify your Backchannel email address';
    const instructions = numeric ? `Your Backchannel verification code is ${code}.\n\nEnter it in Backchannel to ${action}.`
      : `Enter this code in Backchannel to ${action}:\n\n${code}`;
    const title = kind === 'recover' ? 'Backchannel passkey recovery' : 'Verify your Backchannel email';
    const expiry = 'This code expires in 15 minutes. If you did not request it, you can ignore this email.';
    await env.ACCOUNT_EMAIL.send({
      from: env.ACCOUNT_EMAIL_FROM.trim(),
      to: email,
      subject: title,
      text: `${instructions}\n\n${expiry}`,
      html: `<div style="margin:0;padding:24px 12px;background:#f4f5f0;color:#18271e;font:16px/1.5 -apple-system,BlinkMacSystemFont,Arial,sans-serif">
        <div style="max-width:440px;margin:auto;padding:24px;border:1px solid #dce5dc;border-radius:14px;background:#fff">
          <div style="color:#237140;font-size:15px;font-weight:700"><img src="https://backchnnl.app/favicon.png" width="26" height="26" alt="" style="vertical-align:middle;margin-right:8px;border-radius:6px">Backchannel</div>
          <h1 style="font-size:22px;line-height:1.25;margin:24px 0 8px">${title}</h1>
          <p style="margin:0 0 12px">Your Backchannel verification code is:</p>
          <p style="margin:0;padding:12px 14px;border-radius:8px;background:#e8f0e9;color:#1b5732"><code style="font-size:${numeric ? 28 : 17}px;font-weight:700;letter-spacing:${numeric ? 4 : 0}px;word-break:break-all">${code}</code></p>
          <p style="margin:16px 0 0;color:#4f6355;font-size:13px">Use it to ${action}. ${expiry}</p>
        </div>
      </div>`,
    });
  } catch {
    await db.prepare('DELETE FROM account_email_codes WHERE code_hash = ?').bind(codeHash).run();
    console.error('Backchannel email delivery failed', kind);
    return fail('email-unavailable', 503);
  }
  return reply({ ok: true, ...(verificationId && { verificationId }), retryAfter: emailSendInterval / 1000, remainingResends: emailSendLimit - budget.send_count });
}

async function takeEmailCode(env, kind, email, input, auth) {
  const db = env.ACCOUNTS_DB;
  const code = typeof input?.code === 'string' ? input.code.trim() : '';
  const codePattern = /^[A-Za-z0-9_-]{22}$/;
  const verificationId = input?.verificationId;
  if (!email) return null;
  const scope = `kind = ? AND email_hash = ? AND session_hash IS ? AND expires_at > ?
    AND (account_id IS NULL OR EXISTS (
      SELECT 1 FROM accounts WHERE id = account_email_codes.account_id AND recovery_epoch = account_email_codes.recovery_epoch
    ))`;
  const context = [kind, await hashToken(email), auth?.tokenHash ?? null, Date.now()];
  if (verificationId !== undefined) {
    const secret = env.ACCOUNT_EMAIL_CODE_SECRET;
    if (!secret || typeof verificationId !== 'string' || !codePattern.test(verificationId) || !/^[0-9]{6}$/.test(code)) return null;
    const hash = await hashNumericEmailCode(secret, verificationId, code);
    const attempt = `verification_id = ? AND failed_attempts < ? AND ${scope}`;
    const [claimed] = await db.batch([
      db.prepare(`DELETE FROM account_email_codes WHERE code_hash = ? AND ${attempt} RETURNING account_id, recovery_epoch`)
        .bind(hash, verificationId, emailCodeAttempts, ...context),
      db.prepare(`UPDATE account_email_codes SET failed_attempts = failed_attempts + 1 WHERE ${attempt}`)
        .bind(verificationId, emailCodeAttempts, ...context),
    ]);
    return claimed.results[0] ?? null;
  }
  if (!codePattern.test(code)) return null;
  return db.prepare(`
    DELETE FROM account_email_codes
    WHERE code_hash = ? AND ${scope}
    RETURNING account_id, recovery_epoch
  `).bind(await hashToken(code), ...context).first();
}

async function takeSignInRecovery(db, ceremony, { syncKeyVerifier, syncKeySignature }) {
  const who = `c.id = ? AND c.kind = 'login' AND c.session_hash IS NULL AND c.expires_at > ?
    AND a.recovery_email = c.recovery_email AND a.recovery_epoch = c.recovery_epoch`;
  let publicKey = null;
  if (syncKeySignature !== undefined) {
    const proof = await db.prepare(`
      SELECT a.sync_key_public FROM ceremonies c JOIN accounts a ON a.id = c.account_id WHERE ${who}
    `).bind(ceremony, Date.now()).first();
    publicKey = proof?.sync_key_public;
    if (!await verifySyncSignature(publicKey, syncKeySignature, 'backchannel-key-recovery', ceremony)) return null;
  }
  const verifier = publicKey ? null : syncKeyVerifier;
  return db.prepare(`
    DELETE FROM ceremonies WHERE id IN (
      SELECT c.id FROM ceremonies c JOIN accounts a ON a.id = c.account_id WHERE ${who}
        AND a.sync_key_public IS ? AND a.sync_key_verifier IS ?
    )
    RETURNING account_id, recovery_email AS email, recovery_epoch
  `).bind(ceremony, Date.now(), publicKey, verifier).first().then(proof => proof && { ...proof, sync_key_public: publicKey });
}

async function authenticate(request, db) {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get('Authorization') || '');
  if (!match) return null;
  const tokenHash = await hashToken(match[1]);
  const session = await db.prepare(
    'SELECT account_id FROM sessions WHERE token_hash = ? AND expires_at > ?',
  ).bind(tokenHash, Date.now()).first();
  return session && { account: session.account_id, tokenHash };
}

async function beginCeremony(db, kind, rpID, auth, emailProof) {
  const ceremony = crypto.randomUUID();
  const account = kind === 'register' ? crypto.randomUUID() : emailProof?.account_id ?? null;
  const now = Date.now();
  const expiresAt = now + (kind === 'register' ? emailCodeAge : ceremonyAge);
  let options;
  if (kind === 'register' || kind === 'recover') {
    options = await generateRegistrationOptions({
      rpName: 'Backchannel', rpID, userName: emailProof?.email ?? account, userDisplayName: 'Backchannel account',
      userID: textEncoder.encode(account), attestationType: 'none', supportedAlgorithmIDs: [-7, -257],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
  } else {
    let allowCredentials;
    if (auth) {
      const keys = await db.prepare('SELECT id FROM passkeys WHERE account_id = ?').bind(auth.account).all();
      if (!keys.results.length) return fail('sign-in-required', 401);
      allowCredentials = keys.results;
    }
    options = await generateAuthenticationOptions({ rpID, userVerification: 'required', allowCredentials });
  }

  const insert = auth
    ? db.prepare(`
        INSERT INTO ceremonies (id, kind, session_hash, challenge, expires_at)
        SELECT ?, ?, token_hash, ?, ? FROM sessions WHERE token_hash = ? AND expires_at > ?
      `).bind(ceremony, kind, options.challenge, expiresAt, auth.tokenHash, Date.now())
    : emailProof ? db.prepare(`
        INSERT INTO ceremonies (id, kind, account_id, challenge, expires_at, recovery_email, recovery_epoch)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(ceremony, kind, account, options.challenge, expiresAt, emailProof.email, emailProof.recovery_epoch)
    : db.prepare(`
        INSERT INTO ceremonies (id, kind, account_id, challenge, expires_at) VALUES (?, ?, ?, ?, ?)
      `).bind(ceremony, kind, account, options.challenge, expiresAt);
  const created = await insert.run();
  if (!created.meta.changes) return fail('sign-in-required', 401);
  return reply({ mode: kind, ceremony, options, expiresAt, ...((kind === 'register' || emailProof?.sync_key_public) && { keyProofVersion: 2 }) });
}

async function register(db, verification, kind, ceremony, { assertion, envelope, syncKeyVerifier, syncKeyPublic, syncKeySignature }) {
  let key, counter;
  try {
    const result = await verifyRegistrationResponse(verification);
    if (!result.verified || !result.registrationInfo) return fail('invalid-credential', 401);
    key = result.registrationInfo.credential;
    const handle = assertion.response?.userHandle;
    if (assertion.id !== key.id || (handle != null && handle !== encodeBytes(textEncoder.encode(ceremony.account_id)))) {
      return fail('invalid-credential', 401);
    }
    const confirmed = await verifyAuthenticationResponse({ ...verification, response: assertion, credential: key });
    if (!confirmed.verified) return fail('invalid-credential', 401);
    counter = confirmed.authenticationInfo.newCounter;
  } catch {
    return fail('invalid-credential', 401);
  }
  if (syncKeyPublic) {
    const purpose = kind === 'recover' ? 'backchannel-key-replace' : 'backchannel-key-register';
    if (!await verifySyncSignature(syncKeyPublic, syncKeySignature, purpose, ceremony.id, syncKeyPublic)) return fail('invalid-credential', 401);
  }
  const verifier = syncKeyPublic ? null : syncKeyVerifier;
  const publicProof = syncKeyPublic ?? null;
  const token = encodeBytes(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = await hashToken(token);
  const account = ceremony.account_id;
  const publicKey = encodeBytes(key.publicKey);
  if (kind === 'recover') {
    const expiresAt = Date.now() + sessionAge;
    const [replacement] = await db.batch([
      db.prepare(`
        INSERT INTO sessions (token_hash, account_id, expires_at)
        SELECT ?, id, ? FROM accounts
        WHERE id = ? AND recovery_epoch = ? AND sync_key_verifier IS ? AND sync_key_public IS ?
          AND NOT EXISTS (SELECT 1 FROM passkeys WHERE id = ?)
      `).bind(tokenHash, expiresAt, account, ceremony.recovery_epoch, verifier, publicProof, key.id),
      db.prepare(`
        DELETE FROM passkeys WHERE account_id = ? AND EXISTS (SELECT 1 FROM sessions WHERE token_hash = ?)
      `).bind(account, tokenHash),
      db.prepare(`
        DELETE FROM sessions WHERE account_id = ? AND token_hash != ?
          AND EXISTS (SELECT 1 FROM sessions WHERE token_hash = ?)
      `).bind(account, tokenHash, tokenHash),
      db.prepare(`
        INSERT INTO passkeys (id, account_id, public_key, counter)
        SELECT ?, account_id, ?, ? FROM sessions WHERE token_hash = ?
      `).bind(key.id, publicKey, counter, tokenHash),
      db.prepare(`
        INSERT INTO account_key_envelopes (credential_id, envelope)
        SELECT ?, ? FROM sessions WHERE token_hash = ?
      `).bind(key.id, envelope, tokenHash),
      db.prepare(`
        UPDATE accounts SET recovery_epoch = recovery_epoch + 1 WHERE id = ?
          AND EXISTS (SELECT 1 FROM sessions WHERE token_hash = ?)
      `).bind(account, tokenHash),
    ]);
    if (!replacement.meta.changes) return fail('invalid-credential', 401);
    return reply({ account, token, expiresAt, ...(publicProof && { keyProofVersion: 2 }) });
  }

  const expiresAt = Date.now() + emailCodeAge;
  await db.prepare(`
    INSERT INTO account_signups (token_hash, account_id, recovery_email, credential_id, public_key,
      counter, envelope, sync_key_verifier, sync_key_public, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(tokenHash, account, ceremony.recovery_email, key.id, publicKey, counter, envelope, verifier, publicProof, expiresAt).run();
  return reply({ signup: token, expiresAt }, 202);
}

async function finishSignup(request, db) {
  const { signup } = await readJSON(request, 512) ?? {};
  if (!validSyncVerifier(signup)) return fail('invalid-credential', 400);
  const signupHash = await hashToken(signup);
  const now = Date.now();
  const pending = await db.prepare('SELECT * FROM account_signups WHERE token_hash = ? AND expires_at > ?')
    .bind(signupHash, now).first();
  if (!pending) return fail('signup-expired', 401);
  const { account_id: account, recovery_email: email, credential_id: credential, public_key: publicKey,
    counter, envelope, sync_key_public: proofKey } = pending;
  const token = encodeBytes(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = await hashToken(token);
  const expiresAt = now + sessionAge;
  const [created] = await db.batch([
    db.prepare(`
      INSERT INTO accounts (id, recovery_email, sync_key_verifier, sync_key_public)
      SELECT account_id, recovery_email, sync_key_verifier, sync_key_public FROM account_signups
      WHERE token_hash = ? AND expires_at > ?
      ON CONFLICT(recovery_email) WHERE recovery_email IS NOT NULL DO NOTHING
    `).bind(signupHash, now),
    db.prepare(`
      INSERT INTO passkeys (id, account_id, public_key, counter)
      SELECT ?, id, ?, ? FROM accounts WHERE id = ?
        AND EXISTS (SELECT 1 FROM account_signups WHERE token_hash = ?)
    `).bind(credential, publicKey, counter, account, signupHash),
    db.prepare(`
      INSERT INTO account_key_envelopes (credential_id, envelope)
      SELECT id, ? FROM passkeys WHERE id = ? AND account_id = ?
        AND EXISTS (SELECT 1 FROM account_signups WHERE token_hash = ?)
    `).bind(envelope, credential, account, signupHash),
    db.prepare(`
      INSERT INTO sessions (token_hash, account_id, expires_at)
      SELECT ?, id, ? FROM accounts WHERE id = ?
        AND EXISTS (SELECT 1 FROM account_signups WHERE token_hash = ?)
    `).bind(tokenHash, expiresAt, account, signupHash),
    db.prepare('DELETE FROM account_signups WHERE token_hash = ?').bind(signupHash),
  ]);
  if (!created.meta.changes) {
    const existing = await db.prepare('SELECT 1 FROM accounts WHERE recovery_email = ? AND id != ?').bind(email, account).first();
    return existing ? fail('email-in-use', 409) : fail('signup-expired', 401);
  }
  return reply({ account, token, expiresAt, ...(proofKey && { keyProofVersion: 2 }) }, 201);
}

async function beginUnlock(db, key, counter, supportsUpgrade) {
  const saved = await db.prepare(`
    SELECT e.envelope, a.sync_key_public FROM account_key_envelopes e JOIN passkeys p ON p.id = e.credential_id
    JOIN accounts a ON a.id = p.account_id WHERE e.credential_id = ?
  `).bind(key.id).first();
  if (!saved) return fail('passkey-sync-unavailable', 409);
  const unlock = encodeBytes(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = await hashToken(unlock);
  const statements = [db.prepare(`
    INSERT INTO account_unlocks (token_hash, credential_id, expires_at)
    SELECT ?, p.id, ? FROM passkeys p JOIN accounts a ON a.id = p.account_id
    WHERE p.id = ? AND p.counter = ? AND (a.sync_key_verifier IS NOT NULL OR a.sync_key_public IS NOT NULL)
  `).bind(tokenHash, Date.now() + unlockAge, key.id, key.counter)];
  if (counter !== key.counter) {
    statements.push(db.prepare(`
      UPDATE passkeys SET counter = ? WHERE id = ?
        AND EXISTS (SELECT 1 FROM account_unlocks WHERE token_hash = ?)
    `).bind(counter, key.id, tokenHash));
  }
  const [created] = await db.batch(statements);
  if (!created.meta.changes) return fail('retry-sign-in', 409);
  const keyProofVersion = saved.sync_key_public ? 2 : supportsUpgrade ? 1 : undefined;
  return reply({ account: key.account_id, envelope: saved.envelope, unlock, keyProofVersion });
}

async function completeUnlock(request, db) {
  const { unlock, syncKeyVerifier, syncKeyPublic, syncKeySignature } = await readJSON(request, 512) ?? {};
  if (!validSyncVerifier(unlock)) return fail('invalid-credential', 400);
  const unlockHash = await hashToken(unlock);
  const access = await db.prepare(`
    SELECT a.sync_key_public FROM account_unlocks g JOIN passkeys p ON p.id = g.credential_id
    JOIN accounts a ON a.id = p.account_id WHERE g.token_hash = ? AND g.expires_at > ?
  `).bind(unlockHash, Date.now()).first();
  if (!access) return fail('passkey-sync-unavailable', 401);
  const currentKey = access.sync_key_public;
  const verifier = validSyncVerifier(syncKeyVerifier) ? syncKeyVerifier : null;
  const upgrading = !currentKey && syncKeyPublic !== undefined;
  const accepted = currentKey
    ? await verifySyncSignature(currentKey, syncKeySignature, 'backchannel-account-unlock', unlock)
    : Boolean(verifier) && (!upgrading ||
      await verifySyncSignature(syncKeyPublic, syncKeySignature, 'backchannel-key-upgrade', unlock, syncKeyPublic));
  const token = encodeBytes(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = await hashToken(token);
  const expiresAt = Date.now() + sessionAge;
  const insert = db.prepare(`
      INSERT INTO sessions (token_hash, account_id, expires_at)
      SELECT ?, a.id, ? FROM account_unlocks g JOIN passkeys p ON p.id = g.credential_id
      JOIN accounts a ON a.id = p.account_id
      WHERE g.token_hash = ? AND g.expires_at > ? AND a.sync_key_verifier IS ? AND a.sync_key_public IS ? AND ?
      RETURNING account_id
    `).bind(tokenHash, expiresAt, unlockHash, Date.now(), currentKey ? null : verifier, currentKey, Number(accepted));
  const upgrade = upgrading ? [db.prepare(`
    UPDATE accounts SET sync_key_public = ?, sync_key_verifier = NULL, recovery_epoch = recovery_epoch + 1
    WHERE id = (SELECT account_id FROM sessions WHERE token_hash = ?)
  `).bind(typeof syncKeyPublic === 'string' ? syncKeyPublic : null, tokenHash)] : [];
  const [created] = await db.batch([
    insert,
    ...upgrade,
    db.prepare('DELETE FROM account_unlocks WHERE token_hash = ?').bind(unlockHash),
  ]);
  const account = created.results[0]?.account_id;
  return account ? reply({ account, token, expiresAt, ...((currentKey || upgrading) && { keyProofVersion: 2 }) }) : fail('passkey-sync-unavailable', 401);
}

async function deleteAccount(db, auth, key) {
  const subject = await topicReportSubject(auth.account);
  const now = Date.now();
  const scope = `id = ?
    AND EXISTS (SELECT 1 FROM sessions WHERE token_hash = ? AND expires_at > ?)
    AND EXISTS (SELECT 1 FROM passkeys WHERE id = ? AND counter = ?)`;
  const bindings = [auth.account, auth.tokenHash, now, key.id, key.counter];
  const [, deleted] = await db.batch([
    db.prepare(`INSERT OR IGNORE INTO account_report_deletions (subject, queued_at) SELECT ?, ? FROM accounts WHERE ${scope}`)
      .bind(subject, now, ...bindings),
    db.prepare(`DELETE FROM accounts WHERE ${scope}`).bind(...bindings),
  ]);
  if (!deleted.meta.changes) return fail('retry-account-deletion', 409);
  return noContent();
}

async function finishCeremony(request, env, kind, rpID, origin, auth) {
  const db = env.ACCOUNTS_DB;
  const body = await readJSON(request, 24_576);
  if (typeof body?.ceremony !== 'string' || !/^[0-9a-f-]{36}$/.test(body.ceremony) ||
      typeof body.credential?.id !== 'string' || !body.credential.id) return fail('invalid-credential', 400);
  const email = kind === 'email' ? normalizeEmail(body.email) : null;
  if (kind === 'email' && !email) return fail('invalid-email', 400);

  const verifyEmailProof = kind === 'register' || kind === 'recover';
  const keyProofValid = body.syncKeyPublic === undefined ? validSyncVerifier(body.syncKeyVerifier)
    : validSyncVerifier(body.syncKeyPublic) && validSyncSignature(body.syncKeySignature);
  if (verifyEmailProof && (!body.assertion?.response || !validEnvelope(body.envelope) || !keyProofValid)) {
    return fail('passkey-sync-required', 400);
  }
  const ceremony = await db.prepare(`
    DELETE FROM ceremonies WHERE id = ? AND kind = ? AND session_hash IS ? AND expires_at > ?
    RETURNING id, account_id, challenge${verifyEmailProof ? ', recovery_email, recovery_epoch' : ''}
  `).bind(body.ceremony, kind, auth?.tokenHash ?? null, Date.now()).first();
  if (!ceremony) return fail('expired-ceremony', 401);
  if (verifyEmailProof && !ceremony.recovery_email) return fail('invalid-email-code', 401);

  const verification = {
    response: body.credential, expectedChallenge: ceremony.challenge, expectedOrigin: origin,
    expectedRPID: rpID, requireUserVerification: true,
  };
  if (verifyEmailProof) return register(db, verification, kind, ceremony, body);

  const key = await db.prepare('SELECT * FROM passkeys WHERE id = ?').bind(body.credential.id).first();
  const intendedAccount = auth?.account ?? ceremony.account_id;
  if (!key && kind === 'login' && body.reportUnknownPasskey === true) return fail('unknown-passkey', 401);
  if (!key || (intendedAccount && key.account_id !== intendedAccount)) return fail('invalid-credential', 401);
  const userHandle = body.credential.response?.userHandle;
  if ((!auth || userHandle != null) && userHandle !== encodeBytes(textEncoder.encode(key.account_id))) {
    return fail('invalid-credential', 401);
  }

  let result;
  try {
    result = await verifyAuthenticationResponse({
      ...verification,
      credential: { id: key.id, publicKey: decodeBytes(key.public_key), counter: key.counter },
    });
  } catch {
    return fail('invalid-credential', 401);
  }
  if (!result.verified) return fail('invalid-credential', 401);
  const counter = result.authenticationInfo.newCounter;
  const revokeTarget = kind.startsWith('device-revoke:') ? kind.slice('device-revoke:'.length) : null;
  if (kind === 'email' || revokeTarget) {
    const confirmed = await db.prepare(`
      UPDATE passkeys SET counter = ? WHERE id = ? AND counter = ?
        AND EXISTS (SELECT 1 FROM sessions WHERE token_hash = ? AND expires_at > ?)
    `).bind(counter, key.id, key.counter, auth.tokenHash, Date.now()).run();
    if (!confirmed.meta.changes) return fail('invalid-credential', 401);
    if (revokeTarget) return handleAccountDevice(request, db, auth, { action: 'disconnect', id: revokeTarget }, { fail, noContent });
    return sendEmailCode(env, 'update', email, auth, body?.codeFormat);
  }
  if (kind === 'delete') return deleteAccount(db, auth, key);
  return beginUnlock(db, key, counter, body.keyProofVersion === 2);
}

async function readSnapshot(db, { account, tokenHash }, previous = false) {
  const table = previous ? 'account_snapshot_history' : 'snapshots';
  return db.prepare(`
    SELECT COALESCE(stored.revision, 0) AS revision, stored.ciphertext
    FROM sessions LEFT JOIN ${table} AS stored ON stored.account_id = sessions.account_id
    WHERE sessions.token_hash = ? AND sessions.account_id = ? AND sessions.expires_at > ?
  `).bind(tokenHash, account, Date.now()).first();
}

async function snapshot(request, db, auth, previous) {
  const { account, tokenHash } = auth;
  if (request.method === 'GET') {
    const current = await readSnapshot(db, auth, previous);
    if (!current) return fail('sign-in-required', 401);
    return previous && !current.revision ? fail('snapshot-history-unavailable', 404) : reply(current);
  }

  const match = /^"(0|[1-9]\d*)"$/.exec(request.headers.get('If-Match') || '');
  const revision = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(revision) || revision >= Number.MAX_SAFE_INTEGER) return fail('revision-required', 428);
  const restoreHeader = request.headers.get('X-Backchannel-Restore-Revision');
  const restore = restoreHeader === null ? null : /^[1-9]\d*$/.test(restoreHeader) ? Number(restoreHeader) : NaN;
  if (restore !== null && (!Number.isSafeInteger(restore) || restore >= revision)) return fail('invalid-snapshot-restore', 400);
  const proof = request.headers.get('X-Backchannel-Sync-Proof');
  if (!validSyncVerifier(proof) && !validSyncSignature(proof)) return fail('snapshot-proof-required', 428);

  const { ciphertext } = await readJSON(request, maxCiphertextChars + 32) ?? {};
  if (typeof ciphertext !== 'string' || ciphertext.length < 38 || ciphertext.length > maxCiphertextChars ||
      ciphertext.length % 4 === 1 || /[^A-Za-z0-9_-]/.test(ciphertext)) return fail('invalid-ciphertext', 400);

  const sessionScope = `FROM sessions JOIN accounts ON accounts.id = sessions.account_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND accounts.id = ?`;
  const access = await db.prepare(`SELECT sync_key_verifier, sync_key_public ${sessionScope}`).bind(tokenHash, Date.now(), account).first();
  if (!access) return fail('sign-in-required', 401);
  const verifier = access.sync_key_verifier;
  const publicKey = access.sync_key_public;
  if (publicKey) {
    if (!validSyncSignature(proof)) return fail('snapshot-proof-upgrade-required', 428);
    if (!await verifySyncSignature(publicKey, proof, 'backchannel-snapshot-write', account, tokenHash, revision, restore, ciphertext)) {
      return fail('snapshot-proof-invalid', 403);
    }
  } else {
    if (!validSyncVerifier(verifier) || !validSyncVerifier(proof)) return fail('snapshot-proof-invalid', 403);
    const key = await crypto.subtle.importKey('raw', decodeBytes(verifier), { name:'HMAC', hash:'SHA-256' }, false, ['verify']);
    const message = textEncoder.encode(JSON.stringify(['backchannel-snapshot-write', 1, account, tokenHash, revision, restore, ciphertext]));
    if (!await crypto.subtle.verify('HMAC', key, decodeBytes(proof), message)) return fail('snapshot-proof-invalid', 403);
  }

  const scope = `EXISTS (SELECT 1 ${sessionScope} AND accounts.sync_key_verifier IS ? AND accounts.sync_key_public IS ?)`;
  const held = [tokenHash, Date.now(), account, verifier, publicKey];
  let result;
  if (revision === 0) {
    result = await db.prepare(`
        INSERT INTO snapshots (account_id, revision, ciphertext)
        SELECT ?, 1, ? WHERE ${scope}
        ON CONFLICT(account_id) DO NOTHING
      `).bind(account, ciphertext, ...held).run();
  } else {
    const update = `
        UPDATE snapshots SET ciphertext = ?, revision = revision + 1 WHERE account_id = ? AND revision = ?
          AND ${scope}`;
    if (restore !== null) {
      result = await db.prepare(`${update} AND EXISTS (
        SELECT 1 FROM account_snapshot_history WHERE account_id = ? AND revision = ?
      )`).bind(ciphertext, account, revision, ...held, account, restore).run();
    } else {
      // Capture the predecessor and publish its replacement in one transaction.
      const [, written] = await db.batch([
        db.prepare(`
          INSERT INTO account_snapshot_history (account_id, revision, ciphertext)
          SELECT account_id, revision, ciphertext FROM snapshots
          WHERE account_id = ? AND revision = ? AND ${scope}
          ON CONFLICT(account_id) DO UPDATE SET revision = excluded.revision, ciphertext = excluded.ciphertext
        `).bind(account, revision, ...held),
        db.prepare(update).bind(ciphertext, account, revision, ...held),
      ]);
      result = written;
    }
  }
  if (result.meta.changes) return reply({ revision: revision + 1 });
  const remote = await readSnapshot(db, auth);
  if (!remote) return fail('sign-in-required', 401);
  if (restore !== null && remote.revision === revision) return fail('snapshot-restore-changed', 409);
  return reply({ error: 'revision-conflict', revision: remote.revision }, 409);
}

async function verifyRecoveryEmail(request, env, auth) {
  const db = env.ACCOUNTS_DB;
  const body = await readJSON(request, 1024);
  const email = normalizeEmail(body?.email);
  const proof = await takeEmailCode(env, 'update', email, body, auth);
  if (!proof) return fail('invalid-email-code', 401);
  const [updated, occupied] = await db.batch([
    db.prepare(`
      UPDATE accounts SET recovery_email = ?, recovery_epoch = recovery_epoch + 1
      WHERE id = ? AND recovery_epoch = ?
        AND EXISTS (SELECT 1 FROM sessions WHERE token_hash = ? AND expires_at > ?)
        AND NOT EXISTS (SELECT 1 FROM accounts WHERE recovery_email = ? AND id != ?)
    `).bind(email, auth.account, proof.recovery_epoch, auth.tokenHash, Date.now(), email, auth.account),
    db.prepare('SELECT id FROM accounts WHERE recovery_email = ? AND id != ?').bind(email, auth.account),
  ]);
  if (updated.meta.changes) return reply({ email });
  if (!await authenticate(request, db)) return fail('sign-in-required', 401);
  if (occupied.results.length) return fail('email-in-use', 409);
  return fail('invalid-email-code', 401);
}

export async function fetchAccount(request, env, url, origin, ctx) {
  const db = env.ACCOUNTS_DB;
  const limiter = env.ACCOUNT_RATE_LIMIT;
  const available = Boolean(db && limiter);
  const hourlyLimit = Number(env.ACCOUNT_EMAIL_HOURLY_LIMIT ?? defaultHourlyEmailLimit);
  const enrollmentLimit = Number(env.ACCOUNT_EMAIL_ENROLLMENT_HOURLY_LIMIT ?? hourlyLimit);
  const emailAvailable = available && typeof env.ACCOUNT_EMAIL?.send === 'function' && Boolean(normalizeEmail(env.ACCOUNT_EMAIL_FROM)) &&
    Number.isSafeInteger(hourlyLimit) && hourlyLimit > 0 && Number.isSafeInteger(enrollmentLimit) && enrollmentLimit > 0 && enrollmentLimit <= hourlyLimit;
  const { method } = request;
  const { pathname, hostname: rpID } = url;
  const requestOrigin = request.headers.get('Origin');
  const requestSite = request.headers.get('Sec-Fetch-Site');
  if ((requestOrigin && requestOrigin !== origin) || requestSite === 'same-site' || requestSite === 'cross-site') {
    return fail('invalid-origin', 403);
  }
  if (method === 'GET' && pathname === '/account/status') {
    return reply({ available, ...(emailAvailable && { emailAvailable, emailContinuation: true }), ...(available && { deviceStepUp: true }) });
  }

  try {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (method === 'POST' && pathname === '/account/diagnostics') return await receiveDiagnostics(request, env, url, ip);
    if (!available) return fail('account-sync-unavailable', 503);
    if (method === 'POST' && pathname === '/account/login/complete') {
      if (!(await limiter.limit({ key: 'login-complete:' + ip })).success) return fail('rate-limited', 429);
      return await completeUnlock(request, db);
    }
    if (method === 'POST' && pathname === '/account/register/complete') {
      if (!(await limiter.limit({ key: 'register-complete:' + ip })).success) return fail('rate-limited', 429);
      return await finishSignup(request, db);
    }
    const emailStart = method === 'POST' && /^\/account\/email\/(register|recover)\/start$/.exec(pathname);
    if (emailStart) {
      if (!emailAvailable) return fail('email-unavailable', 503);
      if (!(await limiter.limit({ key: 'email-send:' + ip })).success) return fail('rate-limited', 429);
      const body = await readJSON(request, 1024);
      const email = normalizeEmail(body?.email);
      if (!email) return fail('invalid-email', 400);
      const [, kind] = emailStart;
      if (kind === 'register' && body?.flow === 'continue') {
        const verificationId = body.codeFormat === 'numeric' && env.ACCOUNT_EMAIL_CODE_SECRET
          ? encodeBytes(crypto.getRandomValues(new Uint8Array(16))) : null;
        ctx.waitUntil(sendEmailCode(env, kind, email, null, body.codeFormat, { verificationId })
          .catch(() => console.error('Backchannel verification email request failed')));
        return reply({ ok: true, ...(verificationId && { verificationId }), retryAfter: emailSendInterval / 1000 });
      }
      if (kind === 'register') return await sendEmailCode(env, kind, email, null, body?.codeFormat);
      const delivery = sendEmailCode(env, kind, email).catch(() => console.error('Backchannel recovery email request failed'));
      ctx.waitUntil(delivery);
      return reply({ ok: true });
    }

    const ceremony = method === 'POST' && /^\/account\/(register|login|recover)\/(options|verify)$/.exec(pathname);
    if (ceremony) {
      const [, kind, step] = ceremony;
      if (kind !== 'login' && !emailAvailable) return fail('email-unavailable', 503);
      if (!(await limiter.limit({ key: kind + ':' + ip })).success) return fail('rate-limited', 429);
      if (step === 'verify') return await finishCeremony(request, env, kind, rpID, origin, null);
      if (kind === 'login') return await beginCeremony(db, kind, rpID);
      const body = await readJSON(request, 1024);
      if (kind === 'recover' && body?.signInCeremony !== undefined) {
        if (typeof body.signInCeremony !== 'string' || !/^[0-9a-f-]{36}$/.test(body.signInCeremony)) return fail('expired-ceremony', 401);
        const valid = body.syncKeySignature === undefined ? validSyncVerifier(body.syncKeyVerifier) : validSyncSignature(body.syncKeySignature);
        if (!valid) return fail('invalid-recovery-key', 400);
        const proof = await takeSignInRecovery(db, body.signInCeremony, body);
        if (!proof) {
          const active = await db.prepare(`
            SELECT 1 FROM ceremonies WHERE id = ? AND kind = 'login' AND expires_at > ? AND recovery_email IS NOT NULL
          `).bind(body.signInCeremony, Date.now()).first();
          return active ? fail('incorrect-recovery-key', 400) : fail('expired-ceremony', 401);
        }
        return await beginCeremony(db, kind, rpID, null, proof);
      }
      const email = normalizeEmail(body?.email);
      const proof = await takeEmailCode(env, kind, email, body);
      if (!proof) return fail('invalid-email-code', 401);
      if (kind === 'recover') {
        if (!validSyncVerifier(body.syncKeyVerifier)) return fail('invalid-recovery-key', 400);
        const matching = await db.prepare('SELECT 1 FROM accounts WHERE id = ? AND sync_key_public IS NULL AND sync_key_verifier = ?')
          .bind(proof.account_id, body.syncKeyVerifier).first();
        if (!matching) return fail('incorrect-recovery-key', 400);
      }
      if (kind === 'register') {
        const occupied = await db.prepare('SELECT id, recovery_epoch, sync_key_public FROM accounts WHERE recovery_email = ?').bind(email).first();
        if (occupied) {
          if (body.flow !== 'continue') return fail('email-in-use', 409);
          return await beginCeremony(db, 'login', rpID, null, { ...occupied, account_id: occupied.id, email });
        }
      }
      return await beginCeremony(db, kind, rpID, null, { ...proof, email });
    }

    const readEmail = method === 'GET' && pathname === '/account/email';
    const emailStep = method === 'POST' && /^\/account\/email\/(options|start|verify)$/.exec(pathname);
    const previous = method === 'GET' && pathname === '/account/snapshot/previous';
    const sync = previous || (pathname === '/account/snapshot' && (method === 'GET' || method === 'PUT'));
    const signOut = pathname === '/account/session' && method === 'DELETE';
    const beginDeletion = pathname === '/account/delete/options' && method === 'POST';
    const finishDeletion = pathname === '/account' && method === 'DELETE';
    const mintTopicToken = pathname === '/account/topic-report-token' && method === 'POST';
    const deviceRoute = matchAccountDeviceRoute(method, pathname);
    if (!readEmail && !emailStep && !sync && !signOut && !beginDeletion && !finishDeletion && !mintTopicToken && !deviceRoute) return fail('not-found', 404);
    if (emailStep && !emailAvailable) return fail('email-unavailable', 503);
    const issuedAt = mintTopicToken ? Date.now() : null;
    const auth = await authenticate(request, db);
    if (!auth) return fail('sign-in-required', 401);
    if (mintTopicToken) {
      if (!env.TOPIC_REPORT_TOKEN_SECRET) return fail('topic-report-unavailable', 503);
      if (!(await limiter.limit({ key: 'topic-report-token:' + auth.account })).success) return fail('rate-limited', 429);
      const token = await topicReportToken(env.TOPIC_REPORT_TOKEN_SECRET, await topicReportSubject(auth.account), 'topic:report', issuedAt);
      return reply({ token });
    }
    if (deviceRoute) {
      if (deviceRoute.action !== 'list' && !(await limiter.limit({ key: 'device-management:' + auth.account })).success) {
        return fail('rate-limited', 429);
      }
      if (deviceRoute.action === 'revoke-options') {
        const target = deviceRevocationTarget((await readJSON(request, 256))?.target);
        return target ? await beginCeremony(db, 'device-revoke:' + target, rpID, auth) : fail('invalid-device', 400);
      }
      if (deviceRoute.action === 'disconnect') {
        const target = deviceRevocationTarget(deviceRoute.id);
        return target ? await finishCeremony(request, env, 'device-revoke:' + target, rpID, origin, auth) : fail('invalid-device', 400);
      }
      return await handleAccountDevice(request, db, auth, deviceRoute, { readJSON, reply, fail, noContent });
    }
    if (readEmail) {
      const record = await db.prepare(`
        SELECT accounts.recovery_email AS email FROM sessions JOIN accounts ON accounts.id = sessions.account_id
        WHERE sessions.token_hash = ? AND sessions.account_id = ? AND sessions.expires_at > ?
      `).bind(auth.tokenHash, auth.account, Date.now()).first();
      return record ? reply(record) : fail('sign-in-required', 401);
    }
    if (emailStep) {
      if (!(await limiter.limit({ key: 'email-update:' + auth.account })).success) return fail('rate-limited', 429);
      if (emailStep[1] === 'options') return await beginCeremony(db, 'email', rpID, auth);
      if (emailStep[1] === 'start') {
        if (!(await limiter.limit({ key: 'email-send:' + ip })).success) return fail('rate-limited', 429);
        return await finishCeremony(request, env, 'email', rpID, origin, auth);
      }
      return await verifyRecoveryEmail(request, env, auth);
    }
    if (sync) {
      if (emailAvailable) {
        const record = await db.prepare('SELECT recovery_email FROM accounts WHERE id = ?').bind(auth.account).first();
        if (!record?.recovery_email) return fail('email-required', 409);
      }
      return await snapshot(request, db, auth, previous);
    }
    if (beginDeletion) {
      if (!(await limiter.limit({ key: 'delete:' + auth.account })).success) return fail('rate-limited', 429);
      return await beginCeremony(db, 'delete', rpID, auth);
    }
    if (finishDeletion) return await finishCeremony(request, env, 'delete', rpID, origin, auth);
    await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(auth.tokenHash).run();
    return noContent();
  } catch (error) {
    if (error instanceof BodyError) return fail(error.message, error.status);
    console.error('Account request failed', method, error?.name);
    return fail('server-error', 500);
  }
}
