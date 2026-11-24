import { DatabaseSync } from 'node:sqlite'
import { MIGRATIONS } from './migrations'

/**
 * SQLite integrado en Electron/Node (`node:sqlite`, SQLite 3.5x con FTS5 y backup en línea).
 * Elegido en la Fase 3 en lugar de better-sqlite3: elimina un módulo nativo que había que recompilar
 * para cada versión de Electron y para Windows (ARCHITECTURE §2 y §5).
 */
export type Db = DatabaseSync

export function openDatabase(file: string): Db {
  const db = new DatabaseSync(file)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 3000;
  `)
  return db
}

export function schemaVersion(db: Db): number {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)')
  const row = db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get() as { v: number }
  return row.v
}

export function pendingMigrations(db: Db) {
  const current = schemaVersion(db)
  return MIGRATIONS.filter((m) => m.version > current)
}

/** Aplica las migraciones pendientes, cada una en su transacción. */
export function migrate(db: Db): number {
  for (const m of pendingMigrations(db)) {
    db.exec('BEGIN')
    try {
      db.exec(m.sql)
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, Date.now())
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw new Error(`Migración ${m.version} (${m.name}) fallida: ${(e as Error).message}`)
    }
  }
  return schemaVersion(db)
}

export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN')
  try {
    const r = fn()
    db.exec('COMMIT')
    return r
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}
