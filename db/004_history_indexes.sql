CREATE INDEX IF NOT EXISTS sinaloa_documents_inbox_history_created_id
  ON sinaloa_documents (
    (split_part(path, '/', 2)),
    (split_part(path, '/', 3)),
    (COALESCE(value->>'createdAt', '')) DESC,
    (COALESCE(value->>'id', '')) DESC
  ) WHERE path LIKE 'inboxes/%';

CREATE INDEX IF NOT EXISTS sinaloa_documents_inbox_history_updated_id
  ON sinaloa_documents (
    (split_part(path, '/', 2)),
    (split_part(path, '/', 3)),
    (COALESCE(value->>'updatedAt', '')) DESC,
    (COALESCE(value->>'id', '')) DESC
  ) WHERE path LIKE 'inboxes/%';

UPDATE sinaloa_documents
SET value = jsonb_set(value, '{cursor}', to_jsonb(
  CASE WHEN value->>'sequence' ~ '^[0-9]+$'
    THEN LPAD(value->>'sequence', 20, '0')
    ELSE COALESCE(value->>'createdAt', '') || '|' || COALESCE(value->>'id', '')
  END), true)
WHERE path LIKE 'inboxes/%/events/%.json' AND (value->>'cursor') IS NULL;

CREATE INDEX IF NOT EXISTS sinaloa_documents_inbox_events_cursor_id
  ON sinaloa_documents (
    (split_part(path, '/', 2)),
    (COALESCE(value->>'cursor', '')),
    (COALESCE(value->>'id', ''))
  ) WHERE path LIKE 'inboxes/%/events/%';
