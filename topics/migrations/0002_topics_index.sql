CREATE TABLE topics_index (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generated_at INTEGER NOT NULL,
  body TEXT NOT NULL,
  page_timestamps TEXT NOT NULL
);
