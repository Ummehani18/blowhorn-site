-- Per-case creation proof for the Cloud support-cases contract. The proof
-- authenticates an idempotent replay of the case create for this row, so a
-- retry never duplicates the case or its private GitHub issue. It is a
-- per-case random, never user data, and is never returned to the browser.
ALTER TABLE support_messages ADD COLUMN creation_proof TEXT;
