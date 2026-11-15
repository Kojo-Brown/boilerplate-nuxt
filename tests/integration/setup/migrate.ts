import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

import type { Sql } from 'postgres'

/** Where the hand-written migrations live, relative to the repository root. */
export const MIGRATIONS_DIR = 'server/db/migrations'

/** The repository root, from this file's location. */
export const repoRoot = path.resolve(import.meta.dirname, '../../..')

/**
 * The migration files, in the order they have to run.
 *
 * Lexical order, which is what the numeric prefixes are for. `drizzle-kit`
 * would read an order out of `meta/_journal.json`, but this directory has no
 * journal — the files are hand-written rather than generated, so the prefix is
 * the whole of the ordering contract and sorting is how it is honoured.
 */
export async function migrationFiles(): Promise<string[]> {
  const entries = await readdir(path.join(repoRoot, MIGRATIONS_DIR))
  return entries.filter((entry) => entry.endsWith('.sql')).sort()
}

/**
 * Applies every migration to an empty database, in order.
 *
 * `sql.unsafe` rather than a tagged template because a migration is a script,
 * not a statement: the tagged form parameterises, and a parameterised query
 * carries exactly one statement. Nothing here is interpolated — the argument is
 * a file on disk in this repository — so the name is louder than the risk.
 *
 * Returns the files it ran, so a caller can assert it ran the ones it meant to
 * rather than silently migrating nothing from a mistyped directory.
 */
export async function applyMigrations(sql: Sql): Promise<string[]> {
  const files = await migrationFiles()

  for (const file of files) {
    const statements = await readFile(path.join(repoRoot, MIGRATIONS_DIR, file), 'utf8')
    await sql.unsafe(statements)
  }

  return files
}
