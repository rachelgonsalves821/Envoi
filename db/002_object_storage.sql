CREATE TABLE IF NOT EXISTS sinaloa_object_quota_usage (
  workspace_id TEXT PRIMARY KEY,
  used_bytes BIGINT NOT NULL DEFAULT 0,
  reserved_bytes BIGINT NOT NULL DEFAULT 0,
  quota_bytes BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (used_bytes >= 0 AND reserved_bytes >= 0 AND quota_bytes > 0)
);

CREATE TABLE IF NOT EXISTS sinaloa_object_quota_reservations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES sinaloa_object_quota_usage(workspace_id),
  bytes BIGINT NOT NULL CHECK (bytes > 0),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'committed', 'released')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE sinaloa_object_quota_reservations ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS sinaloa_object_quota_reservations_workspace ON sinaloa_object_quota_reservations (workspace_id, status);
CREATE INDEX IF NOT EXISTS sinaloa_object_quota_reservations_expiry ON sinaloa_object_quota_reservations (expires_at) WHERE status = 'reserved';
