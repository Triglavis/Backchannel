const encode = bytes => bytes.toBase64({ alphabet: 'base64url', omitPadding: true });
const encoder = new TextEncoder();
const tokenAge = 5 * 60 * 1000;
const retryDelay = 5 * 60 * 1000;

export async function topicReportSubject(account) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode('topic-report:' + account));
  return new Uint8Array(digest).subarray(0, 16).toHex();
}

export async function topicReportToken(secret, subject, scope, issuedAt = Date.now()) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const claims = { aud: 'backchannel-topics', scope, sub: subject, exp: issuedAt + tokenAge };
  const payload = 'v1.' + encode(encoder.encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return payload + '.' + encode(new Uint8Array(signature));
}

export async function flushTopicReportDeletions(env) {
  const db = env.ACCOUNTS_DB;
  if (!db || !env.TOPIC_REPORT_TOKEN_SECRET || !env.TOPIC_REPORTS) return;
  const now = Date.now();
  const { results } = await db.prepare(`
    SELECT subject, queued_at FROM account_report_deletions WHERE next_attempt_at <= ? ORDER BY next_attempt_at, queued_at LIMIT 20
  `).bind(now).all();
  for (const { subject, queued_at } of results) {
    let delivered = false;
    try {
      const token = await topicReportToken(env.TOPIC_REPORT_TOKEN_SECRET, subject, 'topic:report:delete');
      const response = await env.TOPIC_REPORTS.fetch('https://topics.backchnnl.app/internal/account-reports', {
        method: 'DELETE', headers: { Authorization: 'Bearer ' + token }, redirect: 'manual',
      });
      delivered = response.ok;
    } catch {}
    if (delivered) {
      await db.prepare('DELETE FROM account_report_deletions WHERE subject = ? AND queued_at = ?').bind(subject, queued_at).run();
    } else {
      await db.prepare('UPDATE account_report_deletions SET next_attempt_at = ? WHERE subject = ? AND queued_at = ? AND next_attempt_at <= ?')
        .bind(Date.now() + retryDelay, subject, queued_at, now).run();
    }
  }
}
