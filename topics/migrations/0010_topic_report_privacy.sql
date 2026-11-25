UPDATE topic_reports SET url = substr(url, 1, instr(url, '?') - 1) WHERE instr(url, '?') > 0;
CREATE INDEX topic_reports_by_age ON topic_reports(reported_at);
CREATE INDEX topic_reports_by_reporter ON topic_reports(reporter_id);

CREATE TABLE topic_report_revocations (
  reporter_id TEXT PRIMARY KEY,
  revoked_until INTEGER NOT NULL
);
