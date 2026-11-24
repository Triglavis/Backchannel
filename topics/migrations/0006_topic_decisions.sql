CREATE TABLE topic_decisions (
  id INTEGER PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  report_page_id TEXT,
  decided_at INTEGER NOT NULL,
  decision TEXT NOT NULL CHECK (json_valid(decision))
);

CREATE INDEX topic_decisions_by_report ON topic_decisions(report_page_id, decided_at DESC);
CREATE INDEX posts_by_page ON posts(page_id, posted_at DESC, id);
