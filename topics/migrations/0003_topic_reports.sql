CREATE TABLE topic_reports (
  page_id TEXT NOT NULL,
  reporter_id TEXT NOT NULL,
  url TEXT NOT NULL,
  topic TEXT NOT NULL,
  suggested_topic TEXT NOT NULL,
  reported_at INTEGER NOT NULL,
  PRIMARY KEY (page_id, reporter_id)
);
