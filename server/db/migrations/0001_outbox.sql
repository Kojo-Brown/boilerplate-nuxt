-- Transactional outbox — see server/utils/outbox.ts and docs/outbox.md.
-- Run via: pnpm drizzle-kit migrate
-- Or push schema directly: pnpm drizzle-kit push

CREATE TABLE IF NOT EXISTS "outbox" (
  "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "aggregate_type" TEXT NOT NULL,
  "aggregate_id"   TEXT NOT NULL,
  "event_type"     TEXT NOT NULL,
  "payload"        JSONB NOT NULL,
  "attempts"       INTEGER NOT NULL DEFAULT 0,
  "available_at"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  "created_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  "published_at"   TIMESTAMPTZ,
  "failed_at"      TIMESTAMPTZ,
  "last_error"     TEXT
);

-- The index the relay's claim runs on. Partial, so it holds the backlog rather
-- than the history: a delivered row leaves the index and an idle queue costs an
-- empty scan instead of a walk of every event ever emitted.
CREATE INDEX IF NOT EXISTS "outbox_pending_idx"
  ON "outbox" ("available_at", "created_at")
  WHERE "published_at" IS NULL AND "failed_at" IS NULL;
