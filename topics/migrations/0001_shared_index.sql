CREATE TABLE pages (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  domain TEXT NOT NULL,
  description TEXT NOT NULL
);

CREATE TABLE posts (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id),
  source TEXT NOT NULL,
  community TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  posted_at INTEGER NOT NULL,
  comments INTEGER NOT NULL
);

CREATE INDEX posts_by_time ON posts(posted_at DESC, id);

CREATE TABLE embeddings (
  page_id TEXT NOT NULL REFERENCES pages(id),
  model TEXT NOT NULL,
  revision TEXT NOT NULL,
  vector TEXT NOT NULL,
  PRIMARY KEY (page_id, model, revision)
);

CREATE TABLE public_index (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generated_at INTEGER NOT NULL,
  body TEXT NOT NULL
);

CREATE TABLE refresh_lease (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  owner TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

INSERT INTO refresh_lease VALUES (1, '', 0);
