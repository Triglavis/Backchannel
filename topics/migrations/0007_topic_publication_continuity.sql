ALTER TABLE posts ADD COLUMN changed_at INTEGER NOT NULL DEFAULT 0;

CREATE INDEX posts_by_change ON posts(changed_at);
CREATE UNIQUE INDEX topic_decisions_merge_source ON topic_decisions(json_extract(decision, '$.source.id'))
  WHERE json_extract(decision, '$.action') = 'merge';
