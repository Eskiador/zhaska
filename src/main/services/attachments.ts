import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { extOf, kindOfExt, safeDisplayName, UNSUPPORTED, ATTACHMENT_LIMITS, type AttachmentMetaInfo } from '@shared/attachments'
import type { AttachmentPreview, AttachmentRow } from '@shared/ipc/contract'
import type { AttachmentRef } from '@shared/agent/host'
import type { OllamaClient } from '@shared/ollama/client'
import { AppError } from '@core/errors'
import type { AttachmentRecord, AttachmentsRepo } from '../db/repos'
import type { ExtractJob } from '../attachments/extract'
import type { WorkerMessage, WorkerRequest } from '../attachments/worker'

/**
 * Adjuntos (Fase 8, ARCHITECTURE §8). Separación estricta: viven en userData/attachments/<aa>/<sha256>/,
 * nunca dentro del proyecto, y el agente solo puede leerlos (read_attachment). Nada sale del equipo:
 * la extracción es local y las imágenes solo se envían al servidor de Ollama configurado.
 */

export interface AttachmentServiceDeps {
  repo: AttachmentsRepo
  /** userData/attachments */
  root: string
  /** userData/ocr (datos de idioma copiados de node_modules) */
  ocrDir: string
  /** out/main/attachments.js; null = extraer en este mismo hilo (pruebas) */
  workerPath: string | null
  /** Lanza el proceso de extracción (en main: utilityProcess). Sin él, un worker_thread. */
  spawn?: (workerPath: string) => ExtractorProcess
  assets: { pdfFontsDir: string; ocrSources: string[] }
  ollama: () => OllamaClient
  emit: (row: AttachmentRow & { progress?: string }) => void
}

/** Lo que recibe el modelo con un mensaje. */
export interface ModelAttachments {
  /** Bloque de texto que se añade al mensaje del usuario */
  text: string
  /** Imágenes (base64 JPEG) si el modelo tiene visión */
  images: string[]
  /** Adjuntos legibles con read_attachment (todos los de la conversación) */
  refs: AttachmentRef[]
}

const PREVIEW_CHARS = 120_000
const DESCRIBE_PROMPT =
  'Describe con detalle esta imagen en español para otro asistente que no puede verla. Si contiene texto, código, tablas o mensajes de error, transcríbelos literalmente. No inventes nada que no se vea.'

export class AttachmentService {
  private worker: ExtractorProcess | null = null
  private busyJobs = 0
  private idleTimer: NodeJS.Timeout | null = null
  private ocrReady: Promise<void> | null = null
  private thumbs = new Map<string, string>()
  private visionCache = new Map<string, boolean>()

  constructor(private readonly deps: AttachmentServiceDeps) {}

  /** Al arrancar: reanuda los que quedaron a medias y limpia los subidos y no enviados hace más de un día. */
  async init() {
    // Tras restaurar una copia antigua, algún adjunto puede no tener ya sus archivos en el equipo
    for (const a of this.deps.repo.ready()) {
      if (!existsSync(this.dirOf(a.sha256))) this.deps.repo.update(a.id, { status: 'error', error: 'El archivo ya no está en este equipo (se restauró o importó una copia que lo menciona).' })
    }
    for (const a of this.deps.repo.processing()) void this.process(a)
    for (const a of this.deps.repo.orphans(Date.now() - 24 * 3600_000)) await this.removeRecord(a).catch(() => {})
  }

  dirOf(sha256: string) {
    return path.join(this.deps.root, sha256.slice(0, 2), sha256)
  }

  private originalOf(a: { sha256: string; ext: string }) {
    return path.join(this.dirOf(a.sha256), `original${a.ext ? `.${a.ext}` : ''}`)
  }

  async upload(rawName: string, data: Uint8Array): Promise<AttachmentRow> {
    const name = safeDisplayName(rawName)
    const ext = extOf(name)
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    const sha256 = createHash('sha256').update(buf).digest('hex')
    const base = { sha256, name, ext, kind: kindOfExt(ext), size: buf.length }
    // Errores inmediatos: la tarjeta los muestra y el archivo no se guarda
    const reject = (error: string) => this.toRow(this.deps.repo.create({ ...base, status: 'error', error }))
    if (buf.length === 0) return reject('El archivo está vacío.')
    if (buf.length > ATTACHMENT_LIMITS.fileBytes) return reject('Supera el límite de 50 MB.')
    if (UNSUPPORTED[ext]) return reject(UNSUPPORTED[ext]!)

    const dir = this.dirOf(sha256)
    await mkdir(dir, { recursive: true })
    const original = this.originalOf(base)
    if (!existsSync(original)) await writeFile(original, buf)

    // Mismo contenido ya procesado: se reutiliza la extracción
    const done = this.deps.repo.readyWithHash(sha256)
    if (done && done.ext === ext) return this.toRow(this.deps.repo.create({ ...base, kind: done.kind, status: 'ready', meta: done.meta }))
    const rec = this.deps.repo.create({ ...base, status: 'processing' })
    void this.process(rec)
    return this.toRow(rec)
  }

  /** Extrae el contenido en el worker y avisa a la interfaz de cada cambio. */
  private async process(a: AttachmentRecord) {
    const job: ExtractJob = {
      file: this.originalOf(a),
      ext: a.ext,
      dir: this.dirOf(a.sha256),
      ocrDataDir: this.deps.ocrDir,
      ocrCacheDir: path.join(this.deps.ocrDir, 'cache'),
      pdfFontsDir: this.deps.assets.pdfFontsDir,
    }
    try {
      if (!existsSync(job.file)) throw new Error('El archivo original ya no existe.')
      if (a.kind === 'pdf' || a.kind === 'image') await this.ensureOcrData()
      const result = await this.runJob(a.id, job, (progress) => this.deps.emit({ ...this.toRow(this.deps.repo.get(a.id)), progress }))
      await writeFile(path.join(job.dir, 'meta.json'), JSON.stringify(result.meta, null, 1))
      this.deps.emit(this.toRow(this.deps.repo.update(a.id, { kind: result.kind, status: 'ready', meta: result.meta })))
    } catch (e) {
      try {
        this.deps.emit(this.toRow(this.deps.repo.update(a.id, { status: 'error', error: (e as Error).message || 'No se pudo procesar el archivo.' })))
      } catch {
        /* el adjunto se eliminó mientras se procesaba */
      }
    }
  }

  /**
   * Texto de un documento de una base de conocimiento (Fase 12): mismo proceso aislado y mismos lectores que
   * los adjuntos, pero sin guardar nada en el almacén de adjuntos. `dir` es una carpeta temporal.
   */
  async extractText(file: string, ext: string, dir: string): Promise<{ text: string; pages: number | null }> {
    const kind = kindOfExt(ext)
    if (kind === 'archive') throw new Error('Los ZIP no se indexan: descomprímelos en la carpeta.')
    if (kind === 'pdf' || kind === 'image') await this.ensureOcrData()
    const job: ExtractJob = { file, ext, dir, ocrDataDir: this.deps.ocrDir, ocrCacheDir: path.join(this.deps.ocrDir, 'cache'), pdfFontsDir: this.deps.assets.pdfFontsDir }
    const result = await this.runJob(`kb-${randomUUID()}`, job, () => {})
    const text = await readFile(path.join(dir, 'extracted.txt'), 'utf8')
    return { text, pages: result.meta.pages ?? null }
  }

  private async runJob(id: string, job: ExtractJob, onProgress: (m: string) => void, retry = true): Promise<Awaited<ReturnType<typeof import('../attachments/extract').extract>>> {
    if (!this.deps.workerPath) {
      const { extract } = await import('../attachments/extract')
      return extract(job, onProgress)
    }
    try {
      return await this.runInWorker(id, job, onProgress)
    } catch (e) {
      // Si el proceso de extracción se cayó (por este archivo o por otro de la cola), se reintenta una vez con uno nuevo
      if (retry && (e as Error).message === CRASHED) return this.runJob(id, job, onProgress, false)
      throw e
    }
  }

  private runInWorker(id: string, job: ExtractJob, onProgress: (m: string) => void) {
    const worker = this.ensureWorker()
    this.busyJobs++
    if (this.idleTimer) clearTimeout(this.idleTimer)
    return new Promise<Awaited<ReturnType<typeof import('../attachments/extract').extract>>>((resolve, reject) => {
      const onMessage = (m: WorkerMessage) => {
        if (m.id !== id) return
        if (m.type === 'progress') return onProgress(m.message)
        cleanup()
        if (m.type === 'done') resolve(m.result)
        else reject(new Error(m.message))
      }
      const onExit = () => {
        cleanup()
        reject(new Error(CRASHED))
      }
      const cleanup = () => {
        worker.off('message', onMessage)
        worker.off('exit', onExit)
        // Sin trabajo durante 2 minutos, el proceso (pdfjs, OCR…) se cierra y libera su memoria (Fase 11)
        if (--this.busyJobs === 0) {
          if (this.idleTimer) clearTimeout(this.idleTimer)
          this.idleTimer = setTimeout(() => {
            if (this.busyJobs === 0) {
              this.worker?.kill()
              this.worker = null
            }
          }, IDLE_MS)
          this.idleTimer.unref?.()
        }
      }
      worker.on('message', onMessage)
      worker.on('exit', onExit)
      worker.postMessage({ id, job } satisfies WorkerRequest)
    })
  }

  private ensureWorker(): ExtractorProcess {
    if (this.worker) return this.worker
    const w: ExtractorProcess = this.deps.spawn ? this.deps.spawn(this.deps.workerPath!) : threadWorker(this.deps.workerPath!)
    w.on('exit', () => {
      if (this.worker === w) this.worker = null
    })
    this.worker = w
    return w
  }

  /** Copia los datos de OCR (eng + spa) a userData la primera vez: tesseract los lee de una sola carpeta. */
  private ensureOcrData() {
    this.ocrReady ??= (async () => {
      await mkdir(path.join(this.deps.ocrDir, 'cache'), { recursive: true })
      for (const src of this.deps.assets.ocrSources) {
        const dest = path.join(this.deps.ocrDir, path.basename(src))
        if (!existsSync(dest)) await copyFile(src, dest)
      }
    })().catch((e) => {
      // Sin datos de OCR los PDF con texto y las imágenes siguen funcionando; el OCR fallará con su propio mensaje
      console.error('[attachments] datos de OCR no disponibles', e)
      this.ocrReady = null
    })
    return this.ocrReady
  }

  toRow(a: AttachmentRecord): AttachmentRow {
    const { sha256, ...rest } = a
    return { ...rest, thumb: a.meta.hasThumb ? this.thumbOf(sha256) : null }
  }

  private thumbOf(sha256: string): string | null {
    const cached = this.thumbs.get(sha256)
    if (cached) return cached
    try {
      const url = `data:image/jpeg;base64,${readFileSync(path.join(this.dirOf(sha256), 'thumb.jpg')).toString('base64')}`
      if (this.thumbs.size > 300) this.thumbs.clear()
      this.thumbs.set(sha256, url)
      return url
    } catch {
      return null
    }
  }

  get(ids: string[]): AttachmentRow[] {
    return this.deps.repo.byIds(ids).map((a) => this.toRow(a))
  }

  forConversation(conversationId: string): AttachmentRow[] {
    return this.deps.repo.forConversation(conversationId).map((a) => this.toRow(a))
  }

  /** Quitar antes de enviar. Lo ya enviado forma parte del historial y no se borra desde aquí. */
  async remove(id: string) {
    const a = this.deps.repo.get(id)
    if (this.deps.repo.isLinked(id)) throw new AppError('FORBIDDEN', 'Este adjunto ya se envió en un mensaje y forma parte del historial.')
    await this.removeRecord(a)
  }

  private async removeRecord(a: AttachmentRecord) {
    this.deps.repo.delete(a.id)
    if (!this.deps.repo.hashInUse(a.sha256)) {
      this.thumbs.delete(a.sha256)
      await rm(this.dirOf(a.sha256), { recursive: true, force: true })
    }
  }

  async preview(id: string): Promise<AttachmentPreview> {
    const a = this.deps.repo.get(id)
    const dir = this.dirOf(a.sha256)
    const read = (f: string) => readFile(path.join(dir, f), 'utf8').catch(() => null)
    const full = await read('extracted.txt')
    const sheets = await read('sheets.json')
    const entries = await read('entries.json')
    const image = a.meta.hasVision ? await readFile(path.join(dir, 'vision.jpg')).then((b) => `data:image/jpeg;base64,${b.toString('base64')}`, () => null) : null
    return {
      text: full === null ? null : full.slice(0, PREVIEW_CHARS),
      truncated: (full?.length ?? 0) > PREVIEW_CHARS,
      sheets: sheets ? (JSON.parse(sheets) as AttachmentPreview['sheets']) : null,
      entries: entries ? (JSON.parse(entries) as AttachmentPreview['entries']) : null,
      image,
    }
  }

  /** Comprueba los adjuntos de un mensaje antes de enviarlo. */
  validateForSend(ids: string[]): AttachmentRecord[] {
    const list = this.deps.repo.byIds(ids)
    if (list.length !== ids.length) throw new AppError('NOT_FOUND', 'Algún adjunto ya no existe. Quítalo y vuelve a añadirlo.')
    if (list.some((a) => a.status === 'processing')) throw new AppError('CONFLICT', 'Espera a que terminen de procesarse los adjuntos.')
    const bad = list.find((a) => a.status === 'error')
    if (bad) throw new AppError('INVALID_INPUT', `«${bad.name}» no se pudo procesar: quítalo antes de enviar.`)
    return list
  }

  link(messageId: string, ids: string[]) {
    if (ids.length) this.deps.repo.link(messageId, ids)
  }

  async hasVision(model: string): Promise<boolean> {
    const cached = this.visionCache.get(model)
    if (cached !== undefined) return cached
    const v = await this.deps
      .ollama()
      .show(model)
      .then((s) => (s.capabilities ?? []).includes('vision'), () => false)
    this.visionCache.set(model, v)
    return v
  }

  /** Modelo auxiliar para imágenes si el principal no tiene visión: el elegido en ajustes o el primero instalado con visión. */
  async visionHelper(setting: string, exclude: string): Promise<string | null> {
    if (setting === 'off') return null
    if (setting && setting !== 'auto') return (await this.hasVision(setting)) ? setting : null
    const tags = await this.deps.ollama().tags().catch(() => ({ models: [] as { name: string }[] }))
    const names = tags.models.map((m) => m.name).filter((n) => n !== exclude)
    names.sort((a, b) => Number(b.startsWith('gemma4')) - Number(a.startsWith('gemma4')))
    for (const n of names) if (await this.hasVision(n)) return n
    return null
  }

  /** Descripción de una imagen hecha por un modelo de visión local (se guarda para no repetirla). */
  private async describe(a: AttachmentRecord, model: string): Promise<string> {
    const file = path.join(this.dirOf(a.sha256), `description-${model.replace(/[^\w.-]+/g, '_')}.txt`)
    const cached = await readFile(file, 'utf8').catch(() => null)
    if (cached) return cached
    const img = await readFile(path.join(this.dirOf(a.sha256), 'vision.jpg'))
    const r = await this.deps.ollama().chatOnce({ model, messages: [{ role: 'user', content: DESCRIBE_PROMPT, images: [img.toString('base64')] }], options: { temperature: 0.1, num_ctx: 8192 } })
    const text = (r.message?.content ?? '').trim()
    if (!text) throw new Error('El modelo de visión no devolvió ninguna descripción.')
    await writeFile(file, text)
    return text
  }

  /**
   * Contexto para el modelo: texto de los adjuntos de este mensaje (hasta `budgetChars`), imágenes si el
   * modelo tiene visión o, si no, la descripción de un modelo de visión auxiliar. Nunca se simula el análisis.
   */
  async forModel(opts: { ids: string[]; conversationId: string; model: string; visionSetting: string; budgetChars: number; tools: boolean }): Promise<ModelAttachments> {
    const current = this.deps.repo.byIds(opts.ids)
    const all = [...this.deps.repo.forConversation(opts.conversationId), ...current].filter((a, i, arr) => a.status === 'ready' && arr.findIndex((b) => b.id === a.id) === i)
    const refs: AttachmentRef[] = all.map((a) => ({
      id: a.id,
      name: a.name,
      kind: a.kind,
      textFile: path.join(this.dirOf(a.sha256), 'extracted.txt'),
      unzipDir: a.kind === 'archive' ? path.join(this.dirOf(a.sha256), 'unzipped') : null,
      chars: a.meta.chars ?? 0,
    }))
    if (!current.length) return { text: '', images: [], refs }

    const images: string[] = []
    const imgs = current.filter((a) => a.kind === 'image' && a.meta.hasVision)
    const vision = imgs.length ? await this.hasVision(opts.model) : false
    const helper = imgs.length && !vision ? await this.visionHelper(opts.visionSetting, opts.model) : null

    const textual = current.filter((a) => a.kind !== 'image')
    const per = Math.max(2000, Math.floor(opts.budgetChars / Math.max(1, textual.length + imgs.length * 0.3)))
    const blocks: string[] = []
    for (const [i, a] of current.entries()) {
      const head = `[Adjunto ${i + 1}] ${a.name} · ${describeMeta(a)}`
      const text = await readFile(path.join(this.dirOf(a.sha256), 'extracted.txt'), 'utf8').catch(() => '')
      if (a.kind === 'image') {
        const parts = [head]
        if (vision) {
          images.push((await readFile(path.join(this.dirOf(a.sha256), 'vision.jpg'))).toString('base64'))
          parts.push(`(La imagen va adjunta a este mensaje: es la imagen ${images.length}.)`)
        } else if (helper) {
          try {
            parts.push(`[Descripción generada por el modelo de visión ${helper}; tú no ves la imagen]\n${await this.describe(a, helper)}`)
          } catch (e) {
            parts.push(`[No se pudo describir la imagen con ${helper}: ${(e as Error).message}]`)
          }
        } else parts.push(`[El modelo ${opts.model} no puede ver imágenes y no hay ningún modelo de visión instalado. Solo dispones del texto reconocido por OCR. Díselo al usuario si necesita que analices la imagen.]`)
        if (text) parts.push(text.slice(0, 6000))
        blocks.push(parts.join('\n'))
        continue
      }
      const cut = text.length > per
      const more = opts.tools ? `usa read_attachment con name="${a.name}" y offset=${per} para leer el resto` : 'el resto no cabe en el contexto'
      blocks.push(`${head}\n${text.slice(0, per)}${cut ? `\n… (recortado: ${text.length - per} caracteres más; ${more})` : ''}`)
    }
    const intro = `Adjuntos del usuario (${current.length}). Son contexto de solo lectura y NO forman parte del proyecto${opts.tools ? '; puedes volver a leerlos con read_attachment' : ''}:`
    return { text: `${intro}\n\n${blocks.join('\n\n')}`, images, refs }
  }

  dispose() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.worker?.kill()
    this.worker = null
  }
}

const CRASHED = 'El proceso de extracción se detuvo inesperadamente.'
const IDLE_MS = 120_000

/** Proceso o hilo de extracción: la misma interfaz para utilityProcess (Electron) y worker_threads. */
export interface ExtractorProcess {
  on(event: 'message', fn: (m: WorkerMessage) => void): unknown
  on(event: 'exit', fn: () => void): unknown
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  off(event: 'message' | 'exit', fn: (...args: any[]) => void): unknown
  postMessage(m: WorkerRequest): void
  kill(): unknown
}

function threadWorker(file: string): ExtractorProcess {
  const w = new Worker(file)
  w.on('error', (e) => console.error('[attachments] worker', e))
  w.unref()
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on: (event: 'message' | 'exit', fn: (...a: any[]) => void) => w.on(event, fn),
    off: (event, fn) => w.off(event, fn),
    postMessage: (m) => w.postMessage(m),
    kill: () => void w.terminate(),
  } as ExtractorProcess
}

const KIND_LABEL: Record<string, string> = { pdf: 'PDF', doc: 'documento Word', sheet: 'hoja de cálculo', image: 'imagen', code: 'código', archive: 'ZIP', text: 'texto', other: 'archivo' }

export function describeMeta(a: { kind: string; size: number; meta: AttachmentMetaInfo }): string {
  const m = a.meta
  const bits = [KIND_LABEL[a.kind] ?? a.kind, `${Math.max(1, Math.round(a.size / 1024))} KB`]
  if (m.pages) bits.push(`${m.pages} página${m.pages === 1 ? '' : 's'}`)
  if (m.sheets?.length) bits.push(m.sheets.map((s) => `${s.name}: ${s.rows}×${s.cols}`).join(', '))
  if (m.width) bits.push(`${m.width}×${m.height} px`)
  if (m.ocr && a.kind === 'pdf') bits.push(`${m.ocr.pages} página${m.ocr.pages === 1 ? '' : 's'} con OCR`)
  if (m.entries !== undefined) bits.push(`${m.entries} archivos${m.rejected ? `, ${m.rejected} rechazados` : ''}`)
  if (m.chars !== undefined && a.kind !== 'image') bits.push(`${m.chars} caracteres`)
  return bits.join(' · ')
}
