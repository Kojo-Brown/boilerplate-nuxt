-- Upload metadata — see server/db/schema.ts and server/api/uploads/.
-- Run via: pnpm drizzle-kit migrate
-- Or push schema directly: pnpm drizzle-kit push

-- This table was declared in `server/db/schema.ts` and written to by
-- `POST /api/uploads`, `POST /api/uploads/direct` and read by
-- `GET /api/uploads` from the day those routes landed, and no migration ever
-- created it: `0000_initial.sql` creates `todos` and nothing else. Every
-- upload route therefore answered 500 (`relation "uploads" does not exist`)
-- against a database built from this directory, and nothing noticed, because
-- the only tests over that code drive Drizzle through `pg-proxy`, which
-- answers whatever the test tells it to and never parses the SQL. The
-- Testcontainers suite that found it is `tests/integration/migrations.test.ts`
-- — it holds every table in the schema against the real catalog.

CREATE TABLE IF NOT EXISTS "uploads" (
  "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The object key in the bucket. UNIQUE because it is the identity of the
  -- stored object: two rows naming one key would make "which row describes
  -- this object" unanswerable, and the presign route derives the key from the
  -- upload id, so a collision is a bug rather than a user's doing.
  "key"          TEXT NOT NULL UNIQUE,
  "filename"     TEXT NOT NULL,
  "content_type" TEXT NOT NULL,
  "size"         INTEGER NOT NULL,
  "url"          TEXT NOT NULL,
  "created_at"   TIMESTAMPTZ NOT NULL DEFAULT now()
);
