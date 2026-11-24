import { readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Db } from '../db/database'

/**
 * Retención de instantáneas del agente (ARCHITECTURE §10, Fase 9).
 * checkpoints/<proyecto>/blobs/<sha256> guarda el contenido antes y después de cada cambio del agente.
 * Se conservan SIEMPRE las de cambios pendientes de revisar (hacen falta para «Rechazar») y las de cambios
 * más recientes que el plazo configurado; el resto se borra. Las de menos de una hora tampoco se tocan
 * (una tarea en curso puede haberlas escrito antes de registrar el cambio).
 */
const HASH = /^[0-9a-f]{64}$/
const MIN_AGE_MS = 3600_000

export class CheckpointJanitor {
  constructor(
    private readonly deps: { db: Db; root: string; retentionDays: () => number },
  ) {}

  private blobs(): { file: string; size: number; mtimeMs: number; hash: string }[] {
    const out: { file: string; size: number; mtimeMs: number; hash: string }[] = []
    let projects: string[] = []
    try {
      projects = readdirSync(this.deps.root)
    } catch {
      return out
    }
    for (const p of projects) {
      const dir = join(this.deps.root, p, 'blobs')
      let names: string[] = []
      try {
        names = readdirSync(dir)
      } catch {
        continue
      }
      for (const n of names) {
        if (!HASH.test(n)) continue
        try {
          const st = statSync(join(dir, n))
          if (st.isFile()) out.push({ file: join(dir, n), size: st.size, mtimeMs: st.mtimeMs, hash: n })
        } catch {
          /* borrado entre medias */
        }
      }
    }
    return out
  }

  usage(): { bytes: number; blobs: number } {
    const all = this.blobs()
    return { bytes: all.reduce((a, b) => a + b.size, 0), blobs: all.length }
  }

  collect(now = Date.now()): { removed: number; freedBytes: number } {
    const days = Math.max(1, Math.floor(this.deps.retentionDays()))
    const cutoff = now - days * 86_400_000
    const keep = new Set<string>()
    const rows = this.deps.db.prepare("SELECT before_hash AS b, after_hash AS a FROM file_changes WHERE status = 'pending' OR updated_at >= ?").all(cutoff) as { b: string | null; a: string | null }[]
    for (const r of rows) {
      if (r.b) keep.add(r.b)
      if (r.a) keep.add(r.a)
    }
    let removed = 0
    let freedBytes = 0
    for (const b of this.blobs()) {
      if (keep.has(b.hash) || now - b.mtimeMs < MIN_AGE_MS) continue
      try {
        rmSync(b.file, { force: true })
        removed++
        freedBytes += b.size
      } catch {
        /* en uso: la próxima vez */
      }
    }
    return { removed, freedBytes }
  }
}
