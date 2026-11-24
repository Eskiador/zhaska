import nodePath from 'node:path'
import { realpathSync } from 'node:fs'
import { AppError } from '../errors'

/**
 * PathGuard (ARCHITECTURE §9.1): toda ruta que llega del renderer o del agente es RELATIVA a la raíz
 * del proyecto y se valida aquí antes de tocar el disco.
 *
 * Rechaza: rutas absolutas, "..", NUL, rutas UNC/dispositivo, nombres reservados de Windows, flujos ADS,
 * caracteres no válidos en Windows y cualquier ruta cuyo destino real (resolviendo symlinks/junctions)
 * quede fuera de la raíz.
 */

const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i
const WIN_INVALID_CHARS = /[<>:"|?*\u0000-\u001f]/

export interface PathGuardOptions {
  platform?: NodeJS.Platform
  /** Inyectable para tests. Debe lanzar ENOENT si la ruta no existe. */
  realpath?: (p: string) => string
}

export class PathGuard {
  private readonly path: typeof nodePath.posix
  private readonly win: boolean
  private readonly realpath: (p: string) => string
  readonly root: string
  private readonly realRoot: string

  constructor(root: string, opts: PathGuardOptions = {}) {
    const platform = opts.platform ?? process.platform
    this.win = platform === 'win32'
    this.path = this.win ? nodePath.win32 : nodePath.posix
    this.realpath = opts.realpath ?? ((p) => realpathSync.native(p))
    if (!this.path.isAbsolute(root)) throw new AppError('FORBIDDEN_PATH', 'La raíz del proyecto debe ser una ruta absoluta')
    this.root = this.path.resolve(root)
    this.realRoot = this.safeRealpath(this.root) ?? this.root
  }

  /** Normaliza y valida la forma de una ruta relativa. Devuelve segmentos limpios ("" = raíz). */
  normalizeRel(rel: string): string {
    if (typeof rel !== 'string') throw new AppError('FORBIDDEN_PATH', 'Ruta no válida')
    if (rel.includes('\0')) throw new AppError('FORBIDDEN_PATH', 'La ruta contiene caracteres nulos')
    const unified = rel.replace(/\\/g, '/')
    if (unified.startsWith('/') || /^[a-zA-Z]:/.test(unified) || unified.startsWith('//')) {
      throw new AppError('FORBIDDEN_PATH', `Se esperaba una ruta relativa al proyecto: ${rel}`)
    }
    const segments = unified.split('/').filter((s) => s !== '' && s !== '.')
    for (const seg of segments) {
      if (seg === '..') throw new AppError('FORBIDDEN_PATH', `No se permite ".." en las rutas: ${rel}`)
      if (this.win) {
        if (WIN_RESERVED.test(seg)) throw new AppError('FORBIDDEN_PATH', `Nombre reservado de Windows: ${seg}`)
        if (WIN_INVALID_CHARS.test(seg)) throw new AppError('FORBIDDEN_PATH', `Carácter no válido en Windows en: ${seg}`)
        if (/[. ]$/.test(seg)) throw new AppError('FORBIDDEN_PATH', `Un nombre no puede terminar en punto o espacio en Windows: ${seg}`)
      }
    }
    return segments.join('/')
  }

  /** Ruta absoluta validada dentro del proyecto. */
  resolve(rel: string): string {
    const clean = this.normalizeRel(rel)
    const abs = clean ? this.path.resolve(this.root, ...clean.split('/')) : this.root
    if (!this.isInside(abs, this.root)) throw new AppError('FORBIDDEN_PATH', `La ruta sale del proyecto: ${rel}`)
    // Symlinks y junctions: el destino real del ancestro existente más profundo debe seguir dentro.
    const real = this.realOfDeepestExisting(abs)
    if (real && !this.isInside(real, this.realRoot)) {
      throw new AppError('FORBIDDEN_PATH', `La ruta apunta fuera del proyecto (enlace simbólico): ${rel}`)
    }
    return abs
  }

  /** Convierte una ruta absoluta (p. ej. de fs.watch) a relativa con "/"; null si está fuera. */
  toRel(abs: string): string | null {
    const resolved = this.path.resolve(abs)
    if (!this.isInside(resolved, this.root)) return null
    return this.path.relative(this.root, resolved).split(this.path.sep).join('/')
  }

  isInside(child: string, parent: string): boolean {
    const a = this.win ? child.toLowerCase() : child
    const b = this.win ? parent.toLowerCase() : parent
    if (a === b) return true
    const rel = this.path.relative(b, a)
    return rel !== '' && !rel.startsWith('..') && !this.path.isAbsolute(rel)
  }

  private safeRealpath(p: string): string | null {
    try {
      return this.realpath(p)
    } catch {
      return null
    }
  }

  private realOfDeepestExisting(abs: string): string | null {
    let current = abs
    const tail: string[] = []
    for (;;) {
      const real = this.safeRealpath(current)
      if (real) return tail.length ? this.path.join(real, ...tail.reverse()) : real
      const parent = this.path.dirname(current)
      if (parent === current) return null
      tail.push(this.path.basename(current))
      current = parent
    }
  }
}
