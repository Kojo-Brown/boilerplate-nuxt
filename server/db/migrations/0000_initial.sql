-- Drizzle ORM initial migration
-- Run via: pnpm drizzle-kit migrate
-- Or push schema directly: pnpm drizzle-kit push

CREATE TABLE IF NOT EXISTS "todos" (
  "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "title"      TEXT NOT NULL,
  "completed"  BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);
