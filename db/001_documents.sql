CREATE TABLE IF NOT EXISTS sinaloa_documents (
  path TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sinaloa_documents_path_prefix
  ON sinaloa_documents (path text_pattern_ops);
