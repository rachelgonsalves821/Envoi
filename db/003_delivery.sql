CREATE TABLE IF NOT EXISTS sinaloa_event_sequences (
  inbox_id TEXT PRIMARY KEY,
  value BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sinaloa_outbox (
  id TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  available_at TIMESTAMPTZ NOT NULL,
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  last_error TEXT,
  delivered_at TIMESTAMPTZ,
  dead_lettered_at TIMESTAMPTZ,
  delivery_sequence BIGSERIAL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE sinaloa_outbox ADD COLUMN IF NOT EXISTS delivery_sequence BIGSERIAL;

CREATE INDEX IF NOT EXISTS sinaloa_outbox_delivery_queue
  ON sinaloa_outbox (status, available_at, created_at);

CREATE INDEX IF NOT EXISTS sinaloa_outbox_conversation_order
  ON sinaloa_outbox ((value->>'orderingKey'), delivery_sequence);
