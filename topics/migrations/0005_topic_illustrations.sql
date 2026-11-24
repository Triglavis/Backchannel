CREATE TABLE topic_illustrations (
  id TEXT PRIMARY KEY CHECK(length(id) = 64 AND id NOT GLOB '*[^0-9a-f]*'),
  cache_key TEXT NOT NULL UNIQUE,
  jpeg BLOB NOT NULL CHECK(length(jpeg) BETWEEN 5 AND 524288 AND substr(jpeg, 1, 3) = x'ffd8ff' AND substr(jpeg, -2) = x'ffd9'),
  expires_at INTEGER NOT NULL
);

CREATE INDEX topic_illustrations_expiry ON topic_illustrations (expires_at);
