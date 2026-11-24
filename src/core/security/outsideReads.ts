import nodePath from 'node:path'
import { existsSync, realpathSync } from 'node:fs'
import { AppError } from '../errors'
import { PathGuard } from './pathGuard'

/**
 * Lecturas del agente FUERA del proyecto (Fase 9). Por defecto el agente trabaja solo dentro del proyecto;
 * fuera de él únicamente puede LEER, y solo:
 * - en las carpetas que el usuario autorizó para ese proyecto (Ajustes → Agente y permisos), sin preguntar, o
 * - una ruta concreta que el usuario aprueba en ese momento (tarjeta de aprobación con aviso).
 * Nunca puede leer las carpetas bloqueadas (datos internos de ZHASKA, credenciales), rutas de red (UNC) ni
 * flujos alternativos de NTFS. Modificar archivos fuera del proyecto no está permitido con las herramientas
 * de archivos: solo con un comando que el usuario apruebe expresamente (CommandPolicy lo marca peligroso).
 */
export interface OutsideOptions {
  platform?: NodeJS.Platform
  /** Carpetas que nunca se leen (userData de ZHASKA, ~/.ssh…) */
  blocked: string[]
  realpath?: (p: string) => string
  exists?: (p: string) => boolean
}

export class OutsideReads {
  private readonly guards: PathGuard[]
  private readonly approved = new Set<string>()
  private readonly path: typeof nodePath.posix
  private readonly win: boolean
  private readonly realpath: (p: string) => string
  private readonly exists: (p: string) => boolean

  constructor(
    dirs: string[],
    private readonly opts: OutsideOptions,
  ) {
    this.win = (opts.platform ?? process.platform) === 'win32'
    this.path = this.win ? nodePath.win32 : nodePath.posix
    this.realpath = opts.realpath ?? ((p) => realpathSync.native(p))
    this.exists = opts.exists ?? existsSync
    this.guards = dirs.filter((d) => this.path.isAbsolute(d)).map((d) => new PathGuard(d, { platform: opts.platform, realpath: opts.realpath }))
  }

  get dirs(): string[] {
    return this.guards.map((g) => g.root)
  }

  isAbsolute(p: string): boolean {
    return this.path.isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p)
  }

  private key(p: string) {
    const r = this.path.resolve(p)
    return this.win ? r.toLowerCase() : r
  }

  /** Comprueba la forma de la ruta y que no esté bloqueada. Devuelve la ruta real. */
  check(p: string): string {
    if (p.includes('\0')) throw new AppError('FORBIDDEN_PATH', 'La ruta contiene caracteres nulos')
    if (p.startsWith('\\\\') || p.startsWith('//')) throw new AppError('FORBIDDEN_PATH', `No se permiten rutas de red ni de dispositivo: ${p}`)
    if (this.win && p.slice(2).includes(':')) throw new AppError('FORBIDDEN_PATH', `Ruta no válida (flujo alternativo): ${p}`)
    const abs = this.path.resolve(p)
    if (!this.exists(abs)) throw new AppError('NOT_FOUND', `No existe: ${p}. Las rutas del proyecto son relativas a su raíz (p. ej. src/App.tsx).`)
    let real: string
    try {
      real = this.realpath(abs)
    } catch {
      real = abs
    }
    for (const b of this.opts.blocked) {
      for (const candidate of [abs, real]) {
        const rel = this.path.relative(this.key(b), this.key(candidate))
        if (rel === '' || (!rel.startsWith('..') && !this.path.isAbsolute(rel))) throw new AppError('FORBIDDEN_PATH', `El agente no puede leer esa carpeta (datos internos de ZHASKA o credenciales): ${p}`)
      }
    }
    return real
  }

  /** Carpeta autorizada que contiene la ruta (comprobando enlaces simbólicos), o null. */
  locate(p: string): { guard: PathGuard; rel: string } | null {
    for (const g of this.guards) {
      const rel = g.toRel(this.path.resolve(p))
      if (rel === null) continue
      try {
        g.resolve(rel)
        return { guard: g, rel }
      } catch {
        return null // un enlace que sale de la carpeta autorizada necesita aprobación
      }
    }
    return null
  }

  /** El usuario aprobó leer esta ruta (durante esta tarea). */
  approve(p: string): void {
    this.approved.add(this.key(p))
  }

  isApproved(p: string): boolean {
    return this.approved.has(this.key(p))
  }

  /** Ruta lista para leer: autorizada o aprobada. Si no, FORBIDDEN_PATH. */
  resolve(p: string): { guard: PathGuard; rel: string } {
    const real = this.check(p)
    const hit = this.locate(p)
    if (hit) return hit
    if (!this.isApproved(p)) throw new AppError('FORBIDDEN_PATH', `Fuera del proyecto sin permiso: ${p}`)
    return { guard: new PathGuard(this.path.dirname(real), { platform: this.opts.platform, realpath: this.opts.realpath }), rel: this.path.basename(real) }
  }
}
