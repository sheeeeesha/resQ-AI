-- 009_retention
--
-- Retention and purge, under the DPDP Act.
--
-- The shape of this is dictated by a constraint established in 001: the audit
-- log is append-only by trigger and cannot be deleted. That is deliberate, and
-- it is what makes purge interesting rather than trivial.
--
-- So purge does not delete anything. It destroys *content* — the transcript,
-- the summary, the caller identifier, the location text — while leaving the
-- incident row, its classification, its timings and its complete audit trail
-- intact. An auditor can still establish that a call happened, how it was
-- classified, who reviewed it and when its content was destroyed. What they
-- cannot do is read what the caller said, which is the point.
--
-- A hard DELETE would take the audit trail with it and leave no evidence the
-- incident ever existed — worse for accountability, and no better for privacy.

-- ---------------------------------------------------------------------------
-- Retention date as a column
-- ---------------------------------------------------------------------------
--
-- `data_handling.retain_until` already exists inside JSONB, and that is the
-- wrong place for it now that something queries it on a schedule. Casting
-- `jsonb ->> 'retain_until'` to timestamptz is not IMMUTABLE — the result
-- depends on the session's TimeZone — so Postgres refuses to index the
-- expression, and every purge sweep would become a full table scan.
--
-- Promoted to a column for the same reason `location_ambiguity` and
-- `legal_hold` are columns: a value the system filters on belongs somewhere it
-- can be indexed. The JSONB copy stays as the contract's own representation.

ALTER TABLE incidents ADD COLUMN retain_until timestamptz;

-- Backfill from the existing JSONB so no incident is left without a date.
UPDATE incidents
   SET retain_until = (data_handling ->> 'retain_until')::timestamptz
 WHERE data_handling ->> 'retain_until' IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Legal hold
-- ---------------------------------------------------------------------------
--
-- An incident under investigation must survive its retention date.

ALTER TABLE incidents ADD COLUMN legal_hold boolean NOT NULL DEFAULT false;
ALTER TABLE incidents ADD COLUMN legal_hold_reason text;
ALTER TABLE incidents ADD COLUMN purged_at timestamptz;

-- The purge query: everything due, not held, not already purged. Partial, so
-- it stays small — the eligible set is always a fraction of the whole table.
CREATE INDEX incidents_purge_due_idx
    ON incidents (retain_until)
    WHERE purged_at IS NULL AND legal_hold = false;

-- Answers "what are we holding, and why" — a question for an agency's legal
-- team rather than an operator.
CREATE INDEX incidents_legal_hold_idx ON incidents (received_at DESC)
    WHERE legal_hold = true;
