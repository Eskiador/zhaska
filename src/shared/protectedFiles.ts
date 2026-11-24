/**
 * Archivos protegidos (ARCHITECTURE §9.1, editables desde la Fase 9): el agente pide confirmación antes de
 * leerlos o modificarlos, con cualquier herramienta o comando, sea cual sea el nivel de autonomía.
 * Patrones relativos al proyecto: `*` no cruza carpetas, `**` sí; sin barra, se comparan también con el nombre.
 */
export const DEFAULT_PROTECTED_PATTERNS = ['.env*', '*.pem', '*.key', '*.p12', '*.pfx', 'id_rsa*', 'id_ed25519*', '.npmrc', '.git/**']

/** Forma admitida de un patrón: relativo, sin "..", sin unidades ni caracteres de control. */
export const PROTECTED_PATTERN_RE = /^(?!\/)(?![a-zA-Z]:)(?!.*(^|\/)\.\.(\/|$))[^\u0000-\u001f<>|"]{1,200}$/

const cache = new Map<string, RegExp>()

function toRegExp(pattern: string): RegExp {
  let re = cache.get(pattern)
  if (!re) {
    const body = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '\u0000')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')
      .replace(/\u0000/g, '.*')
    re = new RegExp(`^${body}$`, 'i')
    cache.set(pattern, re)
  }
  return re
}

export function globMatch(pattern: string, rel: string): boolean {
  const re = toRegExp(pattern)
  return re.test(rel) || (!pattern.includes('/') && re.test(rel.split('/').pop() ?? ''))
}

/** Patrón protegido que coincide con la ruta relativa (con "/"), o undefined. */
export function protectedHit(rel: string, patterns: readonly string[]): string | undefined {
  const r = rel.replace(/\\/g, '/').replace(/^(\.\/)+/, '')
  return patterns.find((p) => globMatch(p, r) || (p.endsWith('/**') && (r + '/').toLowerCase().startsWith(p.slice(0, -2).toLowerCase())) || r.split('/').some((_, i, parts) => p.endsWith('/**') && globMatch(p, parts.slice(i).join('/'))))
}
