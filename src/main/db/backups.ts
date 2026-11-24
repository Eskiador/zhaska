import { backup, DatabaseSync } from 'node:sqlite'
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Backup } from '@shared/ipc/contract'
import type { Db } from './database'

/**
 * Copias de seguridad con la API de backup en línea de SQLite (no bloquea la app).
 * Nombre: zhaska-AAAAMMDD-HHMMSS-<motivo>.db · motivos: daily, pre-migration, manual y, desde la Fase 9,
 * pre-restore / pre-import (el estado justo antes de restaurar o importar, para poder deshacerlo) y, desde la
 * Fase 10, pre-update (antes de instalar una actualización).
 */
export type BackupReason = 'daily' | 'pre-migration' | 'manual' | 'pre-restore' | 'pre-import' | 'pre-update'
type Reason = BackupReason
const KEEP: Record<Reason, number> = { daily: 7, 'pre-migration': 5, manual: 10, 'pre-restore': 5, 'pre-import': 5, 'pre-update': 3 }
export const BACKUP_NAME = /^zhaska-(\d{8})-(\d{6})-(daily|pre-migration|manual|pre-restore|pre-import|pre-update)\.db$/
const NAME = BACKUP_NAME

const stamp = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export function listBackups(dir: string): Backup[] {
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names
    .map((file) => ({ file, m: NAME.exec(file) }))
    .filter((x): x is { file: string; m: RegExpExecArray } => !!x.m)
    .map(({ file, m }) => {
      const st = statSync(join(dir, file))
      return { file, size: st.size, createdAt: st.mtimeMs, reason: m[3]! }
    })
    .sort((a, b) => b.createdAt - a.createdAt)
}

export async function createBackup(db: Db, dir: string, reason: Reason, keepDaily = KEEP.daily): Promise<Backup> {
  mkdirSync(dir, { recursive: true })
  const now = new Date()
  let file = `zhaska-${stamp(now)}-${reason}.db`
  // Dos copias en el mismo segundo: no sobrescribir
  for (let i = 1; listBackups(dir).some((b) => b.file === file); i++) file = `zhaska-${stamp(new Date(now.getTime() + i * 1000))}-${reason}.db`
  await backup(db, join(dir, file))
  // Archivo autónomo (sin -wal/-shm): se puede copiar, revisar o restaurar tal cual
  const copy = new DatabaseSync(join(dir, file))
  try {
    copy.exec('PRAGMA journal_mode = DELETE')
  } finally {
    copy.close()
  }
  rotate(dir, { ...KEEP, daily: keepDaily })
  return listBackups(dir).find((b) => b.file === file)!
}

/** Copia diaria si aún no hay una de hoy. */
export async function ensureDailyBackup(db: Db, dir: string, keepDaily: number): Promise<Backup | null> {
  const today = stamp(new Date()).slice(0, 8)
  if (listBackups(dir).some((b) => b.reason === 'daily' && b.file.includes(`-${today}-`))) return null
  return createBackup(db, dir, 'daily', keepDaily)
}

function rotate(dir: string, keep: Record<Reason, number>) {
  const all = listBackups(dir)
  for (const reason of Object.keys(keep) as Reason[]) {
    all
      .filter((b) => b.reason === reason)
      .slice(keep[reason])
      .forEach((b) => rmSync(join(dir, b.file), { force: true }))
  }
}
