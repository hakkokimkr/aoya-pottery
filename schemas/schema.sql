DROP TABLE IF EXISTS files;

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  url TEXT NOT NULL,
  size INTEGER NOT NULL,
  content_type TEXT,
  uploaded_at TEXT NOT NULL
);

