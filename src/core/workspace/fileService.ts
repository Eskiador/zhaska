import { promises as fsp, type Dirent } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import type { DirEntry, FileContent } from '@shared/ipc/contract'
import { AppError, fromNodeError } from '../errors'
import { PathGuard } from '../security/pathGuard'

/** Carpetas que se muestran atenuadas y que el watcher ignora. */
export const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', '.nuxt', '.vite', '.turbo', 'coverage', '__pycache__', '.venv', 'venv', '.pytest_cache', '.idea', 'target'])
/** Archivos de sistema que no se listan. */
const HIDDEN_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini'])

export const MAX_EDITABLE_BYTES = 5 * 1024 * 1024
const BINARY_SNIFF_BYTES = 8000

export interface FileServiceDeps {
  trash: (absPath: string) => Promise<void>
  reveal: (absPath: string) => void
}

/** Operaciones de archivos del proyecto, siempre a través de PathGuard. */
export class FileService {
  constructor(
    readonly guard: PathGuard,
    private readonly deps: FileServiceDeps,
  ) {}

  async list(rel: string): Promise<DirEntry[]> {
    const dirAbs = this.guard.resolve(rel)
    const base = this.guard.normalizeRel(rel)
    let dirents: Dirent[]
    try {
      dirents = await fsp.readdir(dirAbs, { withFileTypes: true })
    } catch (e) {
      throw fromNodeError(e, base || 'Raíz del proyecto')
    }
    const entries = await Promise.all(
      dirents
        .filter((d) => !HIDDEN_FILES.has(d.name))
        .map(async (d): Promise<DirEntry | null> => {
          const childRel = base ? `${base}/${d.name}` : d.name
          const abs = path.join(dirAbs, d.name)
          let isDir = d.isDirectory()
          let size: number | undefined
          const symlink = d.isSymbolicLink()
          try {
            if (symlink || d.isFile()) {
              const st = await fsp.stat(abs) // sigue el enlace
              isDir = st.isDirectory()
              size = st.isFile() ? st.size : undefined
            }
          } catch {
            if (symlink) return { name: d.name, rel: childRel, kind: 'file', ignored: true, symlink: true } // enlace roto
          }
          return { name: d.name, rel: childRel, kind: isDir ? 'dir' : 'file', size, ignored: isDir && IGNORED_DIRS.has(d.name), symlink }
        }),
    )
    return entries
      .filter((e): e is DirEntry => e !== null)
      .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, 'es', { numeric: true, sensitivity: 'base' }) : a.kind === 'dir' ? -1 : 1))
  }

  async read(rel: string): Promise<FileContent> {
    const abs = this.guard.resolve(rel)
    const clean = this.guard.normalizeRel(rel)
    try {
      const st = await fsp.stat(abs)
      if (!st.isFile()) throw new AppError('IO', `${clean}: no es un archivo`)
      const base = { rel: clean, size: st.size, mtimeMs: st.mtimeMs }
      if (st.size > MAX_EDITABLE_BYTES) return { ...base, content: '', encoding: 'utf8', eol: 'LF', unsupported: 'too-large' }
      const buf = await fsp.readFile(abs)
      if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { ...base, content: '', encoding: 'utf8', eol: 'LF', unsupported: 'binary' }
      const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
      const content = new TextDecoder('utf-8').decode(bom ? buf.subarray(3) : buf)
      return { ...base, content, encoding: bom ? 'utf8-bom' : 'utf8', eol: content.includes('\r\n') ? 'CRLF' : 'LF', unsupported: null }
    } catch (e) {
      throw fromNodeError(e, clean)
    }
  }

  /**
   * Escritura atómica (archivo temporal + rename en la misma carpeta).
   * Si `expectedMtimeMs` no coincide, el archivo cambió en disco desde que se abrió → CONFLICT.
   */
  async write(rel: string, content: string, encoding: 'utf8' | 'utf8-bom', expectedMtimeMs?: number): Promise<{ mtimeMs: number; size: number }> {
    const abs = this.guard.resolve(rel)
    const clean = this.guard.normalizeRel(rel)
    if (!clean) throw new AppError('INVALID_INPUT', 'Ruta de archivo vacía')
    if (expectedMtimeMs !== undefined) {
      const st = await fsp.stat(abs).catch(() => null)
      if (st && Math.abs(st.mtimeMs - expectedMtimeMs) > 1) {
        throw new AppError('CONFLICT', `${clean} ha cambiado en disco desde que lo abriste`)
      }
    }
    const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.zhaska-${randomBytes(4).toString('hex')}.tmp`)
    try {
      const body = encoding === 'utf8-bom' ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(content, 'utf8')]) : Buffer.from(content, 'utf8')
      await fsp.writeFile(tmp, body, { flag: 'wx' })
      await fsp.rename(tmp, abs)
      const st = await fsp.stat(abs)
      return { mtimeMs: st.mtimeMs, size: st.size }
    } catch (e) {
      await fsp.rm(tmp, { force: true }).catch(() => {})
      throw fromNodeError(e, clean)
    }
  }

  async create(rel: string, kind: 'file' | 'dir'): Promise<void> {
    const abs = this.guard.resolve(rel)
    const clean = this.guard.normalizeRel(rel)
    if (!clean) throw new AppError('INVALID_INPUT', 'Falta el nombre')
    try {
      await fsp.mkdir(path.dirname(abs), { recursive: true })
      if (kind === 'dir') await fsp.mkdir(abs)
      else await fsp.writeFile(abs, '', { flag: 'wx' })
    } catch (e) {
      throw fromNodeError(e, clean)
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const a = this.guard.resolve(from)
    const b = this.guard.resolve(to)
    if (!this.guard.normalizeRel(from) || !this.guard.normalizeRel(to)) throw new AppError('INVALID_INPUT', 'No se puede renombrar la raíz')
    // Permitir cambiar solo mayúsculas/minúsculas en sistemas que no las distinguen
    const sameEntry = a.toLowerCase() === b.toLowerCase() && a !== b
    if (!sameEntry && (await fsp.stat(b).catch(() => null))) throw new AppError('EXISTS', `${to} ya existe`)
    try {
      await fsp.rename(a, b)
    } catch (e) {
      throw fromNodeError(e, from)
    }
  }

  /** A la papelera del sistema (recuperable), nunca borrado definitivo. */
  async trash(rel: string): Promise<void> {
    const abs = this.guard.resolve(rel)
    if (!this.guard.normalizeRel(rel)) throw new AppError('FORBIDDEN_PATH', 'No se puede eliminar la raíz del proyecto')
    await fsp.stat(abs).catch((e) => {
      throw fromNodeError(e, rel)
    })
    await this.deps.trash(abs)
  }

  reveal(rel: string): void {
    this.deps.reveal(this.guard.resolve(rel))
  }
}
