/**
 * Hitos del arranque (Fase 11), en milisegundos desde que arrancó el proceso (process.uptime, que incluye
 * la carga de Electron antes de ejecutar JavaScript). Se consultan con `app.metrics`.
 */
const marks: Record<string, number> = { mainLoaded: Math.round(process.uptime() * 1000) }

export function mark(name: string) {
  marks[name] ??= Math.round(process.uptime() * 1000)
}

export const startupMarks = () => ({ ...marks })
/** Momento (epoch ms) en que arrancó el proceso principal */
export const processStartedAt = Date.now() - Math.round(process.uptime() * 1000)
