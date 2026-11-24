import { readdir, stat } from 'node:fs/promises'
import nodePath from 'node:path'
import type { PathGuard } from '../security/pathGuard'
import { IGNORED_DIRS } from './fileService'

/**
 * Índice de nombres de archivo de un proyecto para «Buscar archivo» (Fase 11: proyectos de 50 000 archivos).
 * Se construye la primera vez que se busca, sin seguir enlaces simbólicos ni entrar en node_modules, .git,
 * dist…, y después se mantiene al día con los cambios que detecta el vigilante (sin volver a recorrer todo).
 */
export const MAX_INDEXED = 300_000

export class FileIndex {
  private files = new Set<string>()
  private built: Promise<void> | null = null
  truncated = false

  constructor(private readonly guard: PathGuard) {}

  get size() {
    return this.files.size
  }

  ensure(): Promise<void> {
    this.built ??= this.walk('').catch((e) => {
      this.built = null
      throw e
    })
    return this.built
  }

  private async walk(start: string) {
    const stack = [start]
    while (stack.length) {
      const dir = stack.pop()!
      let entries
      try {
        entries = await readdir(this.guard.resolve(dir), { withFileTypes: true })
      } catch {
        continue // carpeta borrada o sin permiso
      }
      for (const e of entries) {
        const rel = dir ? `${dir}/${e.name}` : e.name
        if (e.isDirectory()) {
          if (!IGNORED_DIRS.has(e.name)) stack.push(rel)
        } else if (e.isFile()) {
          if (this.files.size >= MAX_INDEXED) {
            this.truncated = true
            return
          }
          this.files.add(rel)
        }
      }
    }
  }

  /** Cambios del vigilante: rutas relativas que se crearon, cambiaron o desaparecieron. */
  async update(paths: string[]): Promise<void> {
    if (!this.built) return // aún no se ha construido: se hará completo al buscar
    await this.built
    for (const rel of paths) {
      if (!rel || rel.split('/').some((seg) => IGNORED_DIRS.has(seg))) continue
      let st = null
      try {
        st = await stat(this.guard.resolve(rel))
      } catch {
        st = null
      }
      if (!st) {
        // Desaparecido: el archivo o todo lo que hubiera debajo si era una carpeta
        this.files.delete(rel)
        const prefix = `${rel}/`
        for (const f of this.files) if (f.startsWith(prefix)) this.files.delete(f)
      } else if (st.isFile()) {
        if (this.files.size < MAX_INDEXED) this.files.add(rel)
      } else if (st.isDirectory()) {
        await this.walk(rel)
      }
    }
  }

  /**
   * Búsqueda difusa por nombre (las letras de la consulta en orden), puntuando más el nombre del archivo,
   * las letras seguidas y los inicios de palabra. 50 000 rutas se recorren en unos milisegundos.
   */
  search(query: string, limit = 50): string[] {
    const q = query.trim().toLowerCase().replace(/\\/g, '/')
    if (!q) return []
    const scored: { f: string; s: number }[] = []
    for (const f of this.files) {
      const s = scorePath(q, f)
      if (s > 0) scored.push({ f, s })
    }
    scored.sort((a, b) => b.s - a.s || a.f.length - b.f.length)
    return scored.slice(0, limit).map((x) => x.f)
  }
}

export function scorePath(q: string, path: string): number {
  const lower = path.toLowerCase()
  const base = nodePath.posix.basename(lower)
  const inBase = subsequence(q, base)
  const inPath = inBase > 0 ? 0 : subsequence(q, lower)
  if (!inBase && !inPath) return 0
  let s = inBase ? inBase * 2 + 10 : inPath
  if (base.startsWith(q)) s += 15
  else if (base.includes(q)) s += 8
  return s - path.length * 0.01
}

function subsequence(q: string, text: string): number {
  let ti = 0
  let s = 0
  let streak = 0
  for (const ch of q) {
    if (ch === ' ') continue
    const i = text.indexOf(ch, ti)
    if (i < 0) return 0
    streak = i === ti ? streak + 1 : 0
    s += 1 + streak * 2 + (i === 0 || /[\s/._-]/.test(text[i - 1]!) ? 3 : 0)
    ti = i + 1
  }
  return s
}
