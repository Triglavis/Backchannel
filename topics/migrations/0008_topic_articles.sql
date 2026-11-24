CREATE TABLE topic_articles (
  topic_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  body TEXT CHECK (body IS NULL OR (json_valid(body) AND length(CAST(body AS BLOB)) <= 196608)),
  owner TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (topic_id, revision)
);

CREATE INDEX topic_articles_expiry ON topic_articles(expires_at);

CREATE TABLE topic_article_publication (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generation INTEGER NOT NULL
);
INSERT INTO topic_article_publication VALUES (1, 0);

CREATE TRIGGER article_index_insert AFTER INSERT ON topics_index BEGIN
  UPDATE topic_article_publication SET generation = generation + 1 WHERE id = 1;
END;
CREATE TRIGGER article_index_update AFTER UPDATE OF body ON topics_index BEGIN
  UPDATE topic_article_publication SET generation = generation + 1 WHERE id = 1;
END;
CREATE TRIGGER article_index_delete AFTER DELETE ON topics_index BEGIN
  UPDATE topic_article_publication SET generation = generation + 1 WHERE id = 1;
END;

CREATE TABLE topic_article_selections (
  request_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL,
  topic_id TEXT NOT NULL,
  label TEXT NOT NULL,
  members TEXT NOT NULL CHECK (json_valid(members) AND length(CAST(members AS BLOB)) <= 196608)
);
