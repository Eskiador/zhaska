export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toLocaleString('es-ES', { maximumFractionDigits: v < 10 ? 1 : 0 })} ${units[i]}`
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${(ms / 1000).toLocaleString('es-ES', { maximumFractionDigits: 1 })} s`
  const s = ms / 1000
  if (s < 60) return `${s.toLocaleString('es-ES', { maximumFractionDigits: 1 })} s`
  const m = Math.floor(s / 60)
  return `${m} m ${Math.round(s % 60)} s`
}

export const extOf = (name: string) => {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i + 1).toLowerCase() : ''
}

/** Trunca por el centro conservando la extensión: "informe-muy-la…rgo.pdf" */
export function middleTruncate(s: string, max = 26): string {
  if (s.length <= max) return s
  const keep = max - 1
  const head = Math.ceil(keep * 0.6)
  return `${s.slice(0, head)}…${s.slice(s.length - (keep - head))}`
}
