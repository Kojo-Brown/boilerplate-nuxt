import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from '../db/schema'

export type Database = ReturnType<typeof drizzle<typeof schema>>

let _db: Database | undefined

export function useDb(): Database {
  if (!_db) {
    const config = useRuntimeConfig()
    const client = postgres(config.databaseUrl as string)
    _db = drizzle(client, { schema })
  }
  return _db
}
