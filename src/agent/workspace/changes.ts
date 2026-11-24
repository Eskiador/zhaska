import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

export interface RecordedChange {
  rel: string
  kind: 'create' | 'modify' | 'delete'
  beforeHash: string | null
  afterHash: string | null
  additions: number
  deletions: number
}

export const sha256 = (buf: Buffer | string) => createHash('sha256').update(buf).digest('hex')

/** Almacén de instantáneas direccionado por contenido (ARCHITECTURE §10). */
export class BlobStore {
  constructor(readonly dir: string) {}
  async put(content: Buffer): Promise<string> {
    const hash = sha256(content)
    const file = path.join(this.dir, hash)
    if (!existsSync(file)) {
      await mkdir(this.dir, { recursive: true })
      await writeFile(file, content, { flag: 'wx' }).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'EEXIST') throw e
      })
    }
    return hash
  }
  get(hash: string): Promise<Buffer> {
    return readFile(path.join(this.dir, hash))
  }
}

/** Cuenta líneas añadidas y eliminadas (prefijo y sufijo comunes; suficiente para el resumen). */
export function lineDelta(before: string, after: string): { additions: number; deletions: number } {
  const lines = (t: string) => {
    if (!t) return []
    const l = t.split(/\r?\n/)
    if (l[l.length - 1] === '') l.pop() // el salto de línea final no es una línea más
    return l
  }
  const a = lines(before)
  const b = lines(after)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length - 1
  let endB = b.length - 1
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--
    endB--
  }
  return { additions: Math.max(0, endB - start + 1), deletions: Math.max(0, endA - start + 1) }
}

/**
 * Registra cada escritura del agente durante una tarea: guarda el contenido previo (una vez por archivo)
 * y el posterior, para poder mostrar el diff, aceptar o restaurar con verificación por hash.
 */
export class ChangeTracker {
  private entries = new Map<string, { before: Buffer | null; beforeHash: string | null }>()

  constructor(
    private readonly blobs: BlobStore,
    private readonly onChange: (c: RecordedChange) => void,
  ) {}

  async beforeWrite(rel: string, abs: string): Promise<void> {
    if (this.entries.has(rel)) return
    const before = existsSync(abs) ? await readFile(abs) : null
    this.entries.set(rel, { before, beforeHash: before ? await this.blobs.put(before) : null })
  }

  async afterWrite(rel: string, after: Buffer | null): Promise<RecordedChange> {
    const e = this.entries.get(rel)
    if (!e) throw new Error(`Cambio no preparado: ${rel}`)
    const afterHash = after ? await this.blobs.put(after) : null
    const kind: RecordedChange['kind'] = e.before === null ? 'create' : after === null ? 'delete' : 'modify'
    const delta = lineDelta(e.before?.toString('utf8') ?? '', after?.toString('utf8') ?? '')
    const change = { rel, kind, beforeHash: e.beforeHash, afterHash, ...delta }
    this.onChange(change)
    return change
  }

  get touched(): string[] {
    return [...this.entries.keys()]
  }
}
