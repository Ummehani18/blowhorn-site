-- Retry bookkeeping for the scheduled re-forward of support cases. The cron
-- trigger re-sends rows whose forwarded_at is NULL, reusing the stored case
-- number and creation proof so Cloud dedupes the case. forward_attempts
-- counts failed forwards (the request path's first try included),
-- forward_last_status is the last HTTP status (0 when the call threw) and
-- next_forward_at is the earliest time the next retry may run. Existing rows
-- start at zero attempts; rows without a case number or proof are never
-- retried.
ALTER TABLE support_messages ADD COLUMN forward_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE support_messages ADD COLUMN forward_last_status INTEGER;
ALTER TABLE support_messages ADD COLUMN next_forward_at TEXT;
CREATE INDEX IF NOT EXISTS idx_support_messages_unforwarded ON support_messages (id) WHERE forwarded_at IS NULL;
