import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AppError } from '@core/errors'
import { MIGRATIONS } from './migrations'
import { BACKUP_NAME, createBackup, type BackupReason } from './backups'
import { openDatabase } from './database'

/**
 * Restaurar una copia e importar datos (Fase 9).
 *
 * La base de datos no se puede sustituir mientras la app la usa, así que la operación se PROGRAMA
 * (`pending-restore.json` en data/), la app se reinicia y `applyPending` la aplica al arrancar, antes de
 * abrir la base de datos. Antes de sustituir nada se guarda una copia del estado actual (pre-restore o
 * pre-import), de modo que siempre se puede volver atrás desde la lista de copias.
 */

export const LATEST_SCHEMA = Math.max(...MIGRATIONS.map((m) => m.version))
const PENDING = 'pending-restore.json'
const LAST = 'last-operation.json'

export interface DbSummary {
  schemaVersion: number
  projects: number
  conversations: number
  messages: number
  attachments: number
}

export interface PendingOperation {
  kind: 'restore' | 'import'
  /** restore: nombre del archivo en backups/; import: id de la carpeta preparada en import/ */
  source: string
  /** Texto para el aviso tras reiniciar (fecha de la copia o nombre del archivo importado) */
  label: string
  requestedAt: number
}

export interface LastOperation {
  kind: 'restore' | 'import'
  label: string
  ok: boolean
  error?: string
  /** Copia del estado anterior (para deshacer) */
  safetyBackup?: string
  at: number
}

/**
 * Comprueba que un archivo es una base de datos de ZHASKA íntegra y compatible, sin tocarlo:
 * trabaja sobre un duplicado temporal (SQLite crea archivos -wal/-shm al abrir).
 */
export function inspectDatabase(file: string, tmpDir: string): DbSummary {
  if (!existsSync(file)) throw new AppError('NOT_FOUND', 'No se encuentra el archivo de la copia.')
  mkdirSync(tmpDir, { recursive: true })
  const tmp = join(tmpDir, `inspect-${randomUUID()}.db`)
  copyFileSync(file, tmp)
  let db: DatabaseSync | null = null
  try {
    try {
      db = new DatabaseSync(tmp)
      db.prepare('SELECT COUNT(*) FROM sqlite_master').get()
    } catch {
      throw new AppError('INVALID_INPUT', 'El archivo no es una base de datos válida.')
    }
    const integrity = Object.values(db.prepare('PRAGMA integrity_check').get() as Record<string, unknown>)[0]
    if (integrity !== 'ok') throw new AppError('INVALID_INPUT', 'La copia está dañada (no supera la comprobación de integridad de SQLite).')
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name))
    if (!tables.has('schema_migrations') || !tables.has('projects') || !tables.has('settings')) throw new AppError('INVALID_INPUT', 'El archivo no es una base de datos de ZHASKA.')
    const v = (db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get() as { v: number }).v
    if (v > LATEST_SCHEMA) throw new AppError('INVALID_INPUT', `La copia es de una versión más nueva de ZHASKA (esquema v${v}; esta versión llega a la v${LATEST_SCHEMA}). Actualiza ZHASKA antes de usarla.`)
    const count = (t: string) => (tables.has(t) ? (db!.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n : 0)
    return { schemaVersion: v, projects: count('projects'), conversations: count('conversations'), messages: count('messages'), attachments: count('attachments') }
  } catch (e) {
    if (e instanceof AppError) throw e
    throw new AppError('INVALID_INPUT', `No se pudo leer la copia: ${(e as Error).message}`)
  } finally {
    db?.close()
    for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`, `${tmp}-journal`]) rmSync(f, { force: true })
  }
}

/** Copia de backups/ por su nombre (nunca una ruta: el nombre se valida con el patrón de las copias). */
export function backupPath(backupsDir: string, file: string): string {
  if (!BACKUP_NAME.test(file) || basename(file) !== file) throw new AppError('INVALID_INPUT', 'Nombre de copia no válido')
  const p = join(backupsDir, file)
  if (!existsSync(p)) throw new AppError('NOT_FOUND', 'Esa copia ya no existe')
  return p
}

export function schedule(dataDir: string, op: Omit<PendingOperation, 'requestedAt'>): void {
  mkdirSync(dataDir, { recursive: true })
  const tmp = join(dataDir, `${PENDING}.tmp`)
  writeFileSync(tmp, JSON.stringify({ ...op, requestedAt: Date.now() } satisfies PendingOperation))
  renameSync(tmp, join(dataDir, PENDING))
}

export function pendingOperation(dataDir: string): PendingOperation | null {
  try {
    const v = JSON.parse(readFileSync(join(dataDir, PENDING), 'utf8')) as PendingOperation
    return (v.kind === 'restore' || v.kind === 'import') && typeof v.source === 'string' ? v : null
  } catch {
    return null
  }
}

export function cancelPending(dataDir: string): void {
  rmSync(join(dataDir, PENDING), { force: true })
}

/** Aviso de la última operación (se muestra una vez tras reiniciar). */
export function takeLastOperation(dataDir: string): LastOperation | null {
  const f = join(dataDir, LAST)
  try {
    const v = JSON.parse(readFileSync(f, 'utf8')) as LastOperation
    rmSync(f, { force: true })
    return v
  } catch {
    return null
  }
}

export interface ApplyPaths {
  dataDir: string
  dbPath: string
  backupsDir: string
  importDir: string
  attachmentsDir: string
}

/**
 * Aplica la operación programada (si la hay) ANTES de abrir la base de datos. Nunca deja la app sin
 * base de datos: si algo falla, se conserva la actual y se registra el error para avisar al usuario.
 */
export async function applyPending(paths: ApplyPaths): Promise<LastOperation | null> {
  const op = pendingOperation(paths.dataDir)
  if (!op) {
    cancelPending(paths.dataDir)
    return null
  }
  cancelPending(paths.dataDir) // nunca se reintenta en bucle si algo falla
  const result: LastOperation = { kind: op.kind, label: op.label, ok: false, at: Date.now() }
  try {
    const source = op.kind === 'restore' ? backupPath(paths.backupsDir, op.source) : join(stagingDir(paths.importDir, op.source), 'zhaska.db')
    inspectDatabase(source, join(paths.dataDir, 'tmp'))
    // 1. Copia de la base de datos entrante (antes de nada: la rotación de copias podría borrar el origen)
    const incoming = `${paths.dbPath}.incoming`
    copyFileSync(source, incoming)

    // 2. Importación: adjuntos (direccionados por contenido: solo se añaden los que faltan; no cambia nada existente)
    if (op.kind === 'import') {
      const src = join(stagingDir(paths.importDir, op.source), 'attachments')
      if (existsSync(src)) mergeAttachments(src, paths.attachmentsDir)
    }

    // 3. Copia de seguridad del estado actual (para deshacer)
    if (existsSync(paths.dbPath)) {
      const current = openDatabase(paths.dbPath)
      try {
        // Vuelca el WAL al archivo principal: así borrar -wal/-shm después no puede perder nada
        current.exec('PRAGMA wal_checkpoint(TRUNCATE)')
        const reason: BackupReason = op.kind === 'restore' ? 'pre-restore' : 'pre-import'
        result.safetyBackup = (await createBackup(current, paths.backupsDir, reason)).file
      } finally {
        current.close()
      }
    }

    // 4. Sustituir la base de datos: el último paso, un renombrado (si algo falla antes, tus datos siguen igual)
    for (const f of [`${paths.dbPath}-wal`, `${paths.dbPath}-shm`]) rmSync(f, { force: true })
    renameSync(incoming, paths.dbPath)

    result.ok = true
    if (op.kind === 'import') {
      try {
        rmSync(stagingDir(paths.importDir, op.source), { recursive: true, force: true })
      } catch {
        /* cleanStaging lo reintentará */
      }
    }
  } catch (e) {
    result.error = (e as Error)?.message ?? String(e)
    rmSync(`${paths.dbPath}.incoming`, { force: true })
  }
  writeFileSync(join(paths.dataDir, LAST), JSON.stringify(result))
  return result
}

export const stagingDir = (importDir: string, id: string) => {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new AppError('INVALID_INPUT', 'Importación no válida')
  return join(importDir, id)
}

/** attachments/<aa>/<sha256>/… : añade las carpetas que no existan (nunca sobrescribe). */
function mergeAttachments(src: string, dest: string) {
  for (const aa of readdirSync(src)) {
    if (!/^[0-9a-f]{2}$/.test(aa)) continue
    for (const sha of readdirSync(join(src, aa))) {
      if (!/^[0-9a-f]{64}$/.test(sha) || !sha.startsWith(aa)) continue
      const target = join(dest, aa, sha)
      if (existsSync(target)) continue
      mkdirSync(join(dest, aa), { recursive: true })
      cpSync(join(src, aa, sha), target, { recursive: true, errorOnExist: true, force: false })
    }
  }
}

/** Borra importaciones preparadas y abandonadas (más de 1 h y sin operación pendiente). */
export function cleanStaging(importDir: string, dataDir: string, now = Date.now()) {
  const pending = pendingOperation(dataDir)
  let names: string[] = []
  try {
    names = readdirSync(importDir)
  } catch {
    return
  }
  for (const n of names) {
    if (pending?.kind === 'import' && pending.source === n) continue
    const p = join(importDir, n)
    try {
      if (now - statSync(p).mtimeMs > 3600_000) rmSync(p, { recursive: true, force: true })
    } catch {
      /* ya no existe */
    }
  }
}
