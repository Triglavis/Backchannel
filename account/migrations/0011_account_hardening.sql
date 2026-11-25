ALTER TABLE account_email_budget ADD COLUMN enrollment_count INTEGER NOT NULL DEFAULT 0;
UPDATE account_email_budget SET enrollment_count = send_count;

ALTER TABLE accounts ADD COLUMN sync_key_public TEXT;

ALTER TABLE account_signups RENAME TO account_signups_legacy;
CREATE TABLE account_signups (
  token_hash TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL UNIQUE,
  recovery_email TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL,
  envelope TEXT NOT NULL CHECK(length(envelope) = 80),
  sync_key_verifier TEXT CHECK(length(sync_key_verifier) = 43),
  sync_key_public TEXT CHECK(length(sync_key_public) = 43),
  expires_at INTEGER NOT NULL,
  CHECK((sync_key_verifier IS NULL) != (sync_key_public IS NULL))
);
INSERT INTO account_signups (token_hash, account_id, recovery_email, credential_id, public_key, counter, envelope, sync_key_verifier, expires_at)
SELECT token_hash, account_id, recovery_email, credential_id, public_key, counter, envelope, sync_key_verifier, expires_at FROM account_signups_legacy;
DROP TABLE account_signups_legacy;
CREATE INDEX account_signups_expiry ON account_signups(expires_at);

CREATE TABLE account_report_deletions (
  subject TEXT PRIMARY KEY NOT NULL,
  queued_at INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX account_report_deletions_retry ON account_report_deletions(next_attempt_at, queued_at);
