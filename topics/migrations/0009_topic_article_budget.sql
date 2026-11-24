CREATE TABLE topic_article_budget (
  day INTEGER PRIMARY KEY,
  generations INTEGER NOT NULL CHECK (generations > 0)
);
