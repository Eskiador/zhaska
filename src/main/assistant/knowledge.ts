import { watch, type FSWatcher } from 'node:fs'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { OllamaClient } from '@shared/ollama/client'
import type { AssistantSource } from '@shared/assistant'
import type { KbCollection, KbDocument, KbProgress } from '@shared/ipc/contract'
import { ATTACHMENT_LIMITS, extOf } from '@shared/attachments'
import { IGNORED_DIRS } from '@core/workspace/fileService'
import { AppError } from '@core/errors'
import type { KnowledgeRepo } from './repos'
import { chunkText, dot, embedDocument, embedQuery, fromBlob, ftsQuery, fuseRankings, toBlob } from './text'

/**
 * Bases de conocimiento del asistente (Fase 12). Todo en local:
 * - los documentos se LEEN de las carpetas que elige el usuario; nunca se copian, mueven ni modifican;
 * - el texto lo saca el mismo extractor que los adjuntos (PDF, OCR, Word, Excel…);
 * - los vectores los calcula un modelo de embeddings en el Ollama de este equipo;
 * - el índice (texto troceado + vectores) vive en la base de datos de ZHASKA y se borra con la base.
 */

/** Formatos que se indexan. Los ZIP y los ejecutables no. */
export const KB_EXTENSIONS = new Set(['pdf', 'docx', 'xlsx', 'csv', 'tsv', 'txt', 'md', 'htm', 'html', 'json', 'xml', 'png', 'jpg', 'jpeg'])
export const KB_MAX_FILES_PER_FOLDER = 5000
const EMBED_BATCH = 16
/** Por debajo de esta similitud, un fragmento encontrado solo por significado no se considera relacionado */
const MIN_SIMILARITY = 0.35
const WATCH_DEBOUNCE_MS = 3000

export interface KnowledgeDeps {
  repo: KnowledgeRepo
  ollama: () => OllamaClient
  embedModel: () => string
  /** Extrae el texto de un archivo con el extractor de adjuntos (en su proceso aparte). */
  extract: (file: string, ext: string, dir: string) => Promise<{ text: string; pages: number | null }>
  /** Carpeta temporal para la extracción (dentro de los datos de ZHASKA) */
  workDir: string
  /** Comprueba que la carpeta no sea sensible (sistema, credenciales, datos de ZHASKA…) */
  folderProblem: (abs: string) => string | null
  emit: (p: KbProgress) => void
  /** false en pruebas: sin vigilar cambios */
  watch?: boolean
}

export class KnowledgeService {
  private queue: Promise<void> = Promise.resolve()
  private progress = new Map<string, KbProgress>()
  private watchers = new Map<string, FSWatcher>()
  private timers = new Map<string, NodeJS.Timeout>()
  private vectorCache = new Map<string, { ids: number[]; vectors: Float32Array[] }>()
  private stopped = false

  constructor(private readonly deps: KnowledgeDeps) {}

  /** Al arrancar: vigila las carpetas y pone al día lo que cambió con la app cerrada. */
  init() {
    for (const f of this.deps.repo.folders()) {
      this.watchFolder(f.id)
      this.enqueue(f.collectionId, f.id)
    }
  }

  dispose() {
    this.stopped = true
    for (const w of this.watchers.values()) w.close()
    for (const t of this.timers.values()) clearTimeout(t)
    this.watchers.clear()
  }

  list(): KbCollection[] {
    return this.deps.repo.collections().map((c) => ({
      ...c,
      folders: this.deps.repo.folders(c.id).map((f) => ({ id: f.id, path: f.path })),
      indexing: this.progress.get(c.id) ?? null,
    }))
  }

  get(id: string): KbCollection {
    const c = this.list().find((x) => x.id === id)
    if (!c) throw new AppError('NOT_FOUND', 'Base de conocimiento no encontrada')
    return c
  }

  create(name: string, confidential: boolean) {
    this.deps.repo.createCollection(name, confidential)
    return this.list()
  }

  update(id: string, patch: { name?: string; confidential?: boolean }) {
    this.deps.repo.updateCollection(id, patch)
    return this.get(id)
  }

  delete(id: string) {
    for (const f of this.deps.repo.folders(id)) this.unwatch(f.id)
    this.deps.repo.deleteCollection(id)
    this.vectorCache.delete(id)
  }

  /** Añade una carpeta elegida por el usuario en el selector (main ya la ha elegido así) y la indexa. */
  addFolder(collectionId: string, abs: string): KbCollection {
    if (!path.isAbsolute(abs)) throw new AppError('INVALID_INPUT', 'Se esperaba una ruta absoluta')
    const problem = this.deps.folderProblem(abs)
    if (problem) throw new AppError('FORBIDDEN_PATH', `No se puede usar esta carpeta. ${problem}`)
    const f = this.deps.repo.addFolder(collectionId, abs)
    this.watchFolder(f.id)
    this.enqueue(collectionId, f.id)
    return this.get(collectionId)
  }

  removeFolder(folderId: string): KbCollection {
    const f = this.deps.repo.folder(folderId)
    this.unwatch(folderId)
    this.deps.repo.removeFolder(folderId)
    this.vectorCache.delete(f.collectionId)
    return this.get(f.collectionId)
  }

  reindex(collectionId: string) {
    for (const f of this.deps.repo.folders(collectionId)) this.enqueue(collectionId, f.id)
  }

  documents(collectionId: string): KbDocument[] {
    const folders = new Map(this.deps.repo.folders(collectionId).map((f) => [f.id, f.path]))
    return this.deps.repo.documents(collectionId).map((d) => ({
      id: d.id,
      collectionId: d.collectionId,
      folderPath: folders.get(d.folderId) ?? '',
      relPath: d.relPath,
      name: path.basename(d.relPath),
      size: d.size,
      status: d.status,
      error: d.error,
      pages: d.pages,
      chunks: d.chunks,
      indexedAt: d.indexedAt,
    }))
  }

  /** Ruta absoluta de un documento indexado (para abrirlo con su programa). */
  documentPath(documentId: string): string {
    const d = this.deps.repo.document(documentId)
    return path.join(this.deps.repo.folder(d.folderId).path, ...d.relPath.split('/'))
  }

  /** Espera a que termine la indexación pendiente (pruebas). */
  idle() {
    return this.queue
  }

  // ───────────── Búsqueda ─────────────

  /**
   * Búsqueda combinada: por palabras (BM25, encuentra códigos, nombres y números exactos) y por significado
   * (vectores, encuentra la respuesta aunque se pregunte con otras palabras). Se fusionan los dos rankings.
   */
  async search(collectionIds: string[], question: string, k = 8): Promise<AssistantSource[]> {
    const ids = collectionIds.filter((id) => this.deps.repo.collections().some((c) => c.id === id))
    if (!ids.length || !question.trim()) return []
    const fts = ftsQuery(question)
    const keyword = fts ? this.deps.repo.keywordSearch(ids, fts, 30) : []

    let semantic: number[] = []
    const [qv] = await this.deps.ollama().embed(this.deps.embedModel(), [embedQuery(question)])
    if (qv) {
      const q = fromBlob(toBlob(qv))
      const scored: { id: number; s: number }[] = []
      for (const cid of ids) {
        const cache = this.vectorsOf(cid)
        for (let i = 0; i < cache.ids.length; i++) {
          const s = dot(q, cache.vectors[i]!)
          if (s >= MIN_SIMILARITY) scored.push({ id: cache.ids[i]!, s })
        }
      }
      semantic = scored.sort((a, b) => b.s - a.s).slice(0, 30).map((x) => x.id)
    }
    const fused = fuseRankings([semantic, keyword]).slice(0, k)
    const hits = this.deps.repo.chunks(fused.map((f) => f.id))
    return hits.map((h, i) => ({ n: i + 1, documentId: h.documentId, collectionId: h.collectionId, name: path.basename(h.relPath), relPath: h.relPath, page: h.page, section: h.section, text: h.text }))
  }

  private vectorsOf(collectionId: string) {
    let c = this.vectorCache.get(collectionId)
    if (!c) {
      const rows = this.deps.repo.vectors([collectionId])
      c = { ids: rows.map((r) => r.id), vectors: rows.map((r) => fromBlob(r.embedding)) }
      this.vectorCache.set(collectionId, c)
    }
    return c
  }

  // ───────────── Indexación ─────────────

  private enqueue(collectionId: string, folderId: string) {
    this.queue = this.queue.then(() => this.indexFolder(collectionId, folderId)).catch((e) => console.error('[kb] indexación', e))
  }

  private setProgress(collectionId: string, p: Omit<KbProgress, 'collectionId'> | null) {
    if (p) this.progress.set(collectionId, { collectionId, ...p })
    else this.progress.delete(collectionId)
    this.deps.emit(p ? { collectionId, ...p } : { collectionId, phase: 'idle', done: 0, total: 0, current: null, errors: 0 })
  }

  private async indexFolder(collectionId: string, folderId: string) {
    if (this.stopped) return
    let folder
    try {
      folder = this.deps.repo.folder(folderId)
    } catch {
      return // la carpeta se quitó mientras esperaba
    }
    this.setProgress(collectionId, { phase: 'scanning', done: 0, total: 0, current: null, errors: 0 })
    const model = this.deps.embedModel()
    const files = await listFiles(folder.path)
    const known = new Map(this.deps.repo.documentsOfFolder(folderId).map((d) => [d.relPath, d]))
    const todo = files.filter((f) => {
      const d = known.get(f.rel)
      return !d || d.size !== f.size || d.mtimeMs !== f.mtimeMs || (d.status === 'indexed' && d.embedModel !== model)
    })
    // Borrados o movidos: fuera del índice
    const present = new Set(files.map((f) => f.rel))
    let changed = false
    for (const d of known.values())
      if (!present.has(d.relPath)) {
        this.deps.repo.deleteDocument(d.id)
        changed = true
      }

    let errors = 0
    for (let i = 0; i < todo.length; i++) {
      if (this.stopped) return
      const f = todo[i]!
      this.setProgress(collectionId, { phase: 'indexing', done: i, total: todo.length, current: f.rel, errors })
      const base = { folderId, collectionId, relPath: f.rel, size: f.size, mtimeMs: f.mtimeMs }
      try {
        if (!this.deps.repo.folders(collectionId).some((x) => x.id === folderId)) return
        const dir = path.join(this.deps.workDir, randomUUID())
        await mkdir(dir, { recursive: true })
        let extracted
        try {
          extracted = await this.deps.extract(f.abs, f.ext, dir)
        } finally {
          await rm(dir, { recursive: true, force: true }).catch(() => {})
        }
        const chunks = chunkText(extracted.text)
        if (!chunks.length) throw new Error('No se encontró texto en el documento.')
        const embeddings: Uint8Array[] = []
        for (let b = 0; b < chunks.length; b += EMBED_BATCH) {
          const batch = chunks.slice(b, b + EMBED_BATCH)
          const vs = await this.deps.ollama().embed(model, batch.map((c) => embedDocument(path.basename(f.rel), c.text)))
          embeddings.push(...vs.map(toBlob))
        }
        this.deps.repo.saveDocument({ ...base, pages: extracted.pages, embedModel: model }, chunks.map((c, j) => ({ ...c, embedding: embeddings[j]! })))
      } catch (e) {
        errors++
        const msg = (e as Error).message || 'No se pudo leer el documento.'
        this.deps.repo.saveError(base, /not found|no encontrado/i.test(msg) && /model/i.test(msg) ? `Falta el modelo de búsqueda ${model}: descárgalo en Modelos.` : msg)
      }
      changed = true
    }
    if (changed) this.vectorCache.delete(collectionId)
    this.setProgress(collectionId, null)
  }

  private watchFolder(folderId: string) {
    if (this.deps.watch === false || this.watchers.has(folderId)) return
    const f = this.deps.repo.folder(folderId)
    try {
      const w = watch(f.path, { recursive: true }, () => {
        const t = this.timers.get(folderId)
        if (t) clearTimeout(t)
        this.timers.set(
          folderId,
          setTimeout(() => {
            this.timers.delete(folderId)
            this.enqueue(f.collectionId, folderId)
          }, WATCH_DEBOUNCE_MS),
        )
      })
      w.on('error', () => this.unwatch(folderId))
      this.watchers.set(folderId, w)
    } catch {
      /* carpeta no disponible (unidad de red desconectada…): se reintenta al reindexar */
    }
  }

  private unwatch(folderId: string) {
    this.watchers.get(folderId)?.close()
    this.watchers.delete(folderId)
    const t = this.timers.get(folderId)
    if (t) clearTimeout(t)
    this.timers.delete(folderId)
  }
}

/** Archivos indexables de una carpeta, sin seguir enlaces ni entrar en carpetas ocultas o de dependencias. */
export async function listFiles(root: string): Promise<{ rel: string; abs: string; ext: string; size: number; mtimeMs: number }[]> {
  const out: { rel: string; abs: string; ext: string; size: number; mtimeMs: number }[] = []
  const stack = ['']
  while (stack.length && out.length < KB_MAX_FILES_PER_FOLDER) {
    const rel = stack.pop()!
    const entries = await readdir(path.join(root, ...rel.split('/').filter(Boolean)), { withFileTypes: true }).catch(() => [])
    for (const d of entries) {
      if (d.name.startsWith('.') || d.name.startsWith('~$')) continue
      const childRel = rel ? `${rel}/${d.name}` : d.name
      if (d.isDirectory()) {
        if (!IGNORED_DIRS.has(d.name)) stack.push(childRel)
        continue
      }
      if (!d.isFile()) continue // enlaces simbólicos y especiales: fuera
      const ext = extOf(d.name)
      if (!KB_EXTENSIONS.has(ext)) continue
      const abs = path.join(root, ...childRel.split('/'))
      const st = await stat(abs).catch(() => null)
      if (!st || st.size === 0 || st.size > ATTACHMENT_LIMITS.fileBytes) continue
      out.push({ rel: childRel, abs, ext, size: st.size, mtimeMs: Math.floor(st.mtimeMs) })
      if (out.length >= KB_MAX_FILES_PER_FOLDER) break
    }
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel))
}
