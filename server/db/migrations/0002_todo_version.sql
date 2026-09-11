-- Optimistic concurrency on todos — see server/utils/optimistic-concurrency.ts
-- and docs/optimistic-concurrency.md.
-- Run via: pnpm drizzle-kit migrate
-- Or push schema directly: pnpm drizzle-kit push

-- DEFAULT 1 rather than 0 so the column reads as "the first version of this
-- row", and so an existing todo is already at a version a client can send back
-- in an If-Match. Backfilling to 0 would have worked equally well and would
-- have made every log line about a pre-migration row look like a missing value.
--
-- NOT NULL with a default is a metadata-only change on Postgres 11+: the
-- existing rows are not rewritten, so this runs in constant time on a table of
-- any size and does not hold an ACCESS EXCLUSIVE lock while it does.
ALTER TABLE "todos"
  ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 1;
