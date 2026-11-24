/**
 * Comprobaciones de nombres dentro de un ZIP (ARCHITECTURE §9.4). Las usan la extracción de adjuntos
 * (Fase 8) y la importación de datos (Fase 9).
 */
export const RESERVED_WIN_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i

/** Extensiones que nunca se extraen ni importan (aunque tampoco se ejecutarían). */
export const EXECUTABLE_EXT = new Set(['exe', 'dll', 'msi', 'scr', 'com', 'vbs', 'vbe', 'lnk', 'jar', 'app', 'dmg', 'pif', 'cpl', 'hta', 'sys', 'drv', 'bat', 'cmd', 'ps1'])

/** Motivo por el que un nombre de entrada es peligroso, o null si es seguro. */
export function unsafeZipName(name: string): string | null {
  if (!name || name.length > 1024) return 'nombre vacío o demasiado largo'
  if (/[\u0000-\u001f]/.test(name)) return 'caracteres de control en el nombre'
  const n = name.replace(/\\/g, '/')
  if (n.startsWith('/') || /^[a-zA-Z]:/.test(n)) return 'ruta absoluta'
  const segs = n.replace(/\/$/, '').split('/')
  for (const s of segs) {
    if (s === '..') return 'intenta salir de la carpeta (..)'
    if (s.includes(':')) return 'nombre con «:» (flujo alternativo o unidad)'
    if (RESERVED_WIN_NAME.test(s)) return `nombre reservado de Windows (${s})`
    if (s !== '.' && /[. ]$/.test(s)) return 'nombre terminado en punto o espacio'
  }
  return null
}
