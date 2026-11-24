import { app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater'
import type { UpdateStatus } from '@shared/ipc/contract'
import { AppError } from '@core/errors'

/**
 * Actualizaciones con electron-updater (ARCHITECTURE §11.3, Fase 10).
 * - Solo se consulta el canal (GitHub Releases) si el usuario lo tiene activado y ya pasó el asistente inicial,
 *   al arrancar y cada 6 h. La consulta solo envía la versión instalada.
 * - Descargar e instalar son siempre decisiones del usuario (autoDownload y autoInstallOnAppQuit desactivados).
 * - El paquete se verifica con su sha512 antes de instalar. Antes de reiniciar se guarda una copia de la base de
 *   datos («antes de actualizar»); las migraciones se aplican en el primer arranque de la nueva versión.
 * - Si esta copia de ZHASKA no tiene canal configurado (app-update.yml), se dice tal cual: nunca se finge.
 */
const SIX_HOURS = 6 * 3600_000

export class UpdateService {
  private status: UpdateStatus
  private timers: NodeJS.Timeout[] = []
  private configured: boolean

  constructor(
    private readonly deps: {
      enabled: () => boolean
      emit: (s: UpdateStatus) => void
      /** Copia de seguridad antes de instalar */
      beforeInstall: () => Promise<void>
      /** Tareas en curso que impiden reiniciar */
      busy: () => boolean
    },
  ) {
    const current = app.getVersion()
    const file = app.isPackaged ? join(process.resourcesPath, 'app-update.yml') : join(app.getAppPath(), 'dev-app-update.yml')
    // Sin repositorio de publicación, electron-builder escribe un app-update.yml sin «provider»: eso no es un canal
    this.configured = existsSync(file) && /^provider:\s*\S+/m.test(readFileSync(file, 'utf8'))
    this.status = this.configured
      ? { state: 'idle', current }
      : {
          state: 'unconfigured',
          current,
          message: app.isPackaged
            ? 'Esta copia de ZHASKA no tiene canal de actualizaciones: se activará cuando se publique en GitHub Releases.'
            : 'En desarrollo no hay actualizaciones automáticas.',
        }
    if (!this.configured) return

    if (!app.isPackaged) autoUpdater.forceDevUpdateConfig = true
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.allowPrerelease = false
    autoUpdater.allowDowngrade = false
    autoUpdater.logger = { info: () => {}, warn: (m: unknown) => console.warn('[updates]', m), error: (m: unknown) => console.warn('[updates]', m), debug: () => {} }
    autoUpdater.on('checking-for-update', () => this.set({ state: 'checking' }))
    autoUpdater.on('update-available', (i: UpdateInfo) => this.set({ state: 'available', ...this.info(i), checkedAt: Date.now() }))
    autoUpdater.on('update-not-available', () => this.set({ state: 'not-available', checkedAt: Date.now() }))
    autoUpdater.on('download-progress', (p: ProgressInfo) => this.set({ state: 'downloading', percent: Math.round(p.percent), bytesPerSec: p.bytesPerSecond, total: p.total, transferred: p.transferred }))
    autoUpdater.on('update-downloaded', (i: UpdateInfo) => this.set({ state: 'downloaded', ...this.info(i), percent: 100 }))
    autoUpdater.on('error', (e: Error) => this.set({ state: 'error', error: friendly(e) }))
  }

  private info(i: UpdateInfo) {
    const notes = typeof i.releaseNotes === 'string' ? i.releaseNotes : Array.isArray(i.releaseNotes) ? i.releaseNotes.map((n) => n.note ?? '').join('\n') : undefined
    return { version: i.version, releaseDate: i.releaseDate, notes: notes ? stripHtml(notes).slice(0, 4000) : undefined }
  }

  private set(patch: Partial<UpdateStatus>) {
    // Al volver a «comprobando» o a un error no se pierde la versión encontrada
    this.status = { ...this.status, ...patch, current: app.getVersion() } as UpdateStatus
    if (patch.state && patch.state !== 'error') delete this.status.error
    this.deps.emit(this.status)
  }

  get(): UpdateStatus {
    return this.status
  }

  /** Comprobación periódica (al arrancar y cada 6 h) si el usuario la tiene activada. */
  start() {
    if (!this.configured) return
    const tick = () => {
      if (this.deps.enabled() && !['downloading', 'downloaded'].includes(this.status.state)) void this.check().catch(() => {})
    }
    this.timers.push(setTimeout(tick, 15_000), setInterval(tick, SIX_HOURS))
    for (const t of this.timers) t.unref()
  }

  async check(): Promise<UpdateStatus> {
    if (!this.configured) return this.status
    if (this.status.state === 'downloading') return this.status
    try {
      await autoUpdater.checkForUpdates()
    } catch (e) {
      this.set({ state: 'error', error: friendly(e as Error) })
    }
    return this.status
  }

  async download(): Promise<UpdateStatus> {
    if (this.status.state !== 'available' && this.status.state !== 'error') throw new AppError('CONFLICT', 'No hay ninguna actualización pendiente de descargar.')
    if (!this.status.version) throw new AppError('CONFLICT', 'Busca primero si hay una actualización.')
    this.set({ state: 'downloading', percent: 0 })
    try {
      await autoUpdater.downloadUpdate()
    } catch (e) {
      this.set({ state: 'error', error: friendly(e as Error) })
    }
    return this.status
  }

  async install(): Promise<void> {
    if (this.status.state !== 'downloaded') throw new AppError('CONFLICT', 'La actualización todavía no está descargada.')
    if (this.deps.busy()) throw new AppError('CONFLICT', 'Hay una tarea del agente o del chat en curso. Espera a que termine o cancélala antes de actualizar.')
    await this.deps.beforeInstall()
    // Windows: instalador NSIS en silencio (por usuario, sin administrador) y la app se vuelve a abrir sola
    setTimeout(() => autoUpdater.quitAndInstall(true, true), 300)
  }

  dispose() {
    for (const t of this.timers) clearTimeout(t)
    this.timers = []
  }
}

function stripHtml(s: string) {
  return s
    .replace(/<\/(p|li|h\d)>/gi, '\n')
    .replace(/<li>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function friendly(e: Error): string {
  const m = e?.message ?? String(e)
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|net::ERR_/i.test(m)) return 'No hay conexión con el servidor de actualizaciones. Inténtalo más tarde.'
  if (/sha512|checksum/i.test(m)) return 'El archivo descargado no coincide con el publicado (sha512). No se ha instalado nada.'
  if (/404|Cannot find latest/i.test(m)) return 'No se encontró información de versiones en el canal de actualizaciones.'
  if (/code signature|did not pass validation/i.test(m)) return 'macOS solo instala actualizaciones de apps firmadas. En Windows no hace falta firma.'
  return m.split('\n')[0]!.slice(0, 300)
}
