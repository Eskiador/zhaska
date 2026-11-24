import nodePath from 'node:path'

/**
 * Carpetas que nunca pueden ser un proyecto ni una carpeta autorizada para el agente (Fase 9).
 * Si lo fueran, el agente podría leer o modificar el sistema, tus credenciales o los datos internos
 * de ZHASKA (base de datos, copias de seguridad, adjuntos).
 */
export interface SensitiveContext {
  platform?: NodeJS.Platform
  home: string
  /** Datos de usuario de ZHASKA (%APPDATA%\ZHASKA) */
  userData: string
  /** Carpeta de instalación del programa */
  appDir?: string
  /** Carpeta temporal del sistema: se permite (pruebas, proyectos de usar y tirar) */
  tempDir?: string
  env?: Record<string, string | undefined>
}

const WIN_SYSTEM = (env: Record<string, string | undefined>) => [
  env['SystemRoot'] ?? env['windir'] ?? 'C:\\Windows',
  env['ProgramFiles'] ?? 'C:\\Program Files',
  env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
  env['ProgramData'] ?? 'C:\\ProgramData',
  'C:\\$Recycle.Bin',
  'C:\\System Volume Information',
  'C:\\Recovery',
]
const POSIX_SYSTEM = ['/System', '/Library', '/usr', '/bin', '/sbin', '/etc', '/var', '/private', '/dev', '/cores', '/boot', '/proc', '/sys', '/lib', '/lib64', '/run', '/snap', '/Applications']
/** Dentro de la carpeta personal: configuración y credenciales */
const HOME_SENSITIVE = ['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.config/gcloud', '.ollama', '.npmrc', 'Library', 'AppData']
/** Excepciones dentro de las anteriores: iCloud Drive y carpetas de sincronización de macOS */
const HOME_ALLOWED = ['Library/Mobile Documents', 'Library/CloudStorage']

export function workspaceRootProblem(abs: string, ctx: SensitiveContext): string | null {
  const win = (ctx.platform ?? process.platform) === 'win32'
  const p = win ? nodePath.win32 : nodePath.posix
  const norm = (x: string) => {
    const r = p.resolve(x)
    return win ? r.toLowerCase() : r
  }
  const target = norm(abs)
  const inside = (child: string, parent: string) => {
    const rel = p.relative(parent, child)
    return rel === '' || (!rel.startsWith('..') && !p.isAbsolute(rel))
  }
  if (p.parse(target).root === target) return 'Es la raíz de un disco: elige la carpeta concreta del proyecto.'
  const userData = norm(ctx.userData)
  const home = norm(ctx.home)
  if (inside(target, userData)) return 'Es la carpeta de datos internos de ZHASKA (base de datos, copias y adjuntos).'
  if (target === home) return 'Es tu carpeta personal completa: elige la carpeta concreta del proyecto.'
  if (inside(home, target)) return 'Contiene las carpetas personales de todos los usuarios: elige la carpeta concreta del proyecto.'
  if (inside(userData, target)) return 'Contiene los datos internos de ZHASKA (base de datos, copias y adjuntos): elige una carpeta más concreta.'
  if (ctx.appDir && (inside(target, norm(ctx.appDir)) || inside(norm(ctx.appDir), target))) return 'Es la carpeta de instalación de ZHASKA.'
  // Temporales (también /private/var/folders de macOS) e iCloud Drive: no hay nada del sistema que proteger
  const temps = [ctx.tempDir, ...(win ? [] : ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders'])].filter((x): x is string => !!x)
  if (temps.some((t) => inside(target, norm(t))) || HOME_ALLOWED.some((s) => inside(target, norm(p.join(ctx.home, s))))) return null
  for (const s of win ? WIN_SYSTEM(ctx.env ?? process.env) : POSIX_SYSTEM) {
    if (inside(target, norm(s))) return `Es una carpeta del sistema (${s}).`
  }
  for (const s of HOME_SENSITIVE) {
    const dir = norm(p.join(ctx.home, s))
    if (inside(target, dir)) return `Es una carpeta de configuración o credenciales (${p.join('~', s)}).`
  }
  return null
}

/** Carpetas que el agente no puede leer nunca, ni con aprobación: datos internos de ZHASKA y credenciales. */
export function blockedReadRoots(home: string, userData: string, platform: NodeJS.Platform = process.platform): string[] {
  const p = platform === 'win32' ? nodePath.win32 : nodePath.posix
  return [userData, ...['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.config/gcloud'].map((s) => p.join(home, s))]
}
