import { randomUUID } from 'node:crypto'
import type { Db } from '../db/database'
import { transaction } from '../db/database'
import { AppError } from '@core/errors'
import type { AssistantConversation, AssistantMessage, ChatMetricsRow, KbCollection } from '@shared/ipc/contract'
import type { Chunk } from './text'

/* ───────────── Bases de conocimiento ───────────── */

interface CollectionDb {
  id: string
  name: string
  confidential: number
  created_at: number
  updated_at: number
  documents: number
  chunks: number
  errors: number
}

export interface FolderRecord {
  id: string
  collectionId: string
  path: string
}

export interface DocumentRecord {
  id: string
  collectionId: string
  folderId: string
  relPath: string
  size: number
  mtimeMs: number
  status: 'indexed' | 'error'
  error: string | null
  pages: number | null
  chunks: number
  embedModel: string | null
  indexedAt: number
}

export interface ChunkHit {
  id: number
  documentId: string
  collectionId: string
  relPath: string
  page: number | null
  section: string | null
  text: string
}

const docOf = (r: Record<string, unknown>): DocumentRecord => ({
  id: r['id'] as string,
  collectionId: r['collection_id'] as string,
  folderId: r['folder_id'] as string,
  relPath: r['rel_path'] as string,
  size: r['size'] as number,
  mtimeMs: r['mtime_ms'] as number,
  status: r['status'] as 'indexed' | 'error',
  error: (r['error'] as string | null) ?? null,
  pages: (r['pages'] as number | null) ?? null,
  chunks: r['chunks'] as number,
  embedModel: (r['embed_model'] as string | null) ?? null,
  indexedAt: r['indexed_at'] as number,
})

export class KnowledgeRepo {
  constructor(private readonly db: Db) {}

  collections(): Omit<KbCollection, 'folders' | 'indexing'>[] {
    const rows = this.db
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM kb_documents d WHERE d.collection_id = c.id AND d.status = 'indexed') AS documents,
                (SELECT COALESCE(SUM(d.chunks), 0) FROM kb_documents d WHERE d.collection_id = c.id) AS chunks,
                (SELECT COUNT(*) FROM kb_documents d WHERE d.collection_id = c.id AND d.status = 'error') AS errors
         FROM kb_collections c ORDER BY c.name COLLATE NOCASE`,
      )
      .all() as unknown as CollectionDb[]
    return rows.map((r) => ({ id: r.id, name: r.name, confidential: !!r.confidential, createdAt: r.created_at, updatedAt: r.updated_at, documents: r.documents, chunks: r.chunks, errors: r.errors }))
  }

  collection(id: string) {
    const c = this.collections().find((x) => x.id === id)
    if (!c) throw new AppError('NOT_FOUND', 'Base de conocimiento no encontrada')
    return c
  }

  createCollection(name: string, confidential: boolean) {
    const id = randomUUID()
    const now = Date.now()
    this.db.prepare('INSERT INTO kb_collections (id, name, confidential, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, name.trim(), confidential ? 1 : 0, now, now)
    return this.collection(id)
  }

  updateCollection(id: string, patch: { name?: string; confidential?: boolean }) {
    this.collection(id)
    if (patch.name !== undefined) this.db.prepare('UPDATE kb_collections SET name = ?, updated_at = ? WHERE id = ?').run(patch.name.trim(), Date.now(), id)
    if (patch.confidential !== undefined) this.db.prepare('UPDATE kb_collections SET confidential = ?, updated_at = ? WHERE id = ?').run(patch.confidential ? 1 : 0, Date.now(), id)
    return this.collection(id)
  }

  /** Borra la base y todo su índice (los documentos originales no se tocan). */
  deleteCollection(id: string) {
    transaction(this.db, () => {
      this.db.prepare('DELETE FROM kb_chunks_fts WHERE rowid IN (SELECT k.id FROM kb_chunks k JOIN kb_documents d ON d.id = k.document_id WHERE d.collection_id = ?)').run(id)
      this.db.prepare('DELETE FROM kb_collections WHERE id = ?').run(id)
    })
  }

  folders(collectionId?: string): FolderRecord[] {
    const rows = (collectionId ? this.db.prepare('SELECT * FROM kb_folders WHERE collection_id = ? ORDER BY added_at').all(collectionId) : this.db.prepare('SELECT * FROM kb_folders ORDER BY added_at').all()) as Record<string, unknown>[]
    return rows.map((r) => ({ id: r['id'] as string, collectionId: r['collection_id'] as string, path: r['path'] as string }))
  }

  folder(id: string): FolderRecord {
    const f = this.folders().find((x) => x.id === id)
    if (!f) throw new AppError('NOT_FOUND', 'Carpeta no encontrada')
    return f
  }

  addFolder(collectionId: string, path: string): FolderRecord {
    this.collection(collectionId)
    const existing = this.folders(collectionId).find((f) => f.path === path)
    if (existing) return existing
    const id = randomUUID()
    this.db.prepare('INSERT INTO kb_folders (id, collection_id, path, added_at) VALUES (?, ?, ?, ?)').run(id, collectionId, path, Date.now())
    return this.folder(id)
  }

  removeFolder(id: string) {
    transaction(this.db, () => {
      this.db.prepare('DELETE FROM kb_chunks_fts WHERE rowid IN (SELECT k.id FROM kb_chunks k JOIN kb_documents d ON d.id = k.document_id WHERE d.folder_id = ?)').run(id)
      this.db.prepare('DELETE FROM kb_folders WHERE id = ?').run(id)
    })
  }

  documents(collectionId: string): DocumentRecord[] {
    return (this.db.prepare('SELECT * FROM kb_documents WHERE collection_id = ? ORDER BY rel_path').all(collectionId) as Record<string, unknown>[]).map(docOf)
  }

  documentsOfFolder(folderId: string): DocumentRecord[] {
    return (this.db.prepare('SELECT * FROM kb_documents WHERE folder_id = ?').all(folderId) as Record<string, unknown>[]).map(docOf)
  }

  document(id: string): DocumentRecord {
    const r = this.db.prepare('SELECT * FROM kb_documents WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!r) throw new AppError('NOT_FOUND', 'Documento no encontrado')
    return docOf(r)
  }

  /** Sustituye el índice de un documento (texto troceado + vectores) en una sola transacción. */
  saveDocument(d: { folderId: string; collectionId: string; relPath: string; size: number; mtimeMs: number; pages: number | null; embedModel: string }, chunks: (Chunk & { embedding: Uint8Array })[]): DocumentRecord {
    return transaction(this.db, () => {
      const prev = this.db.prepare('SELECT id FROM kb_documents WHERE folder_id = ? AND rel_path = ?').get(d.folderId, d.relPath) as { id: string } | undefined
      const id = prev?.id ?? randomUUID()
      if (prev) this.clearChunks(id)
      this.db
        .prepare(
          `INSERT INTO kb_documents (id, collection_id, folder_id, rel_path, size, mtime_ms, status, error, pages, chunks, embed_model, indexed_at)
           VALUES (?, ?, ?, ?, ?, ?, 'indexed', NULL, ?, ?, ?, ?)
           ON CONFLICT (folder_id, rel_path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms, status = 'indexed', error = NULL,
             pages = excluded.pages, chunks = excluded.chunks, embed_model = excluded.embed_model, indexed_at = excluded.indexed_at`,
        )
        .run(id, d.collectionId, d.folderId, d.relPath, d.size, d.mtimeMs, d.pages, chunks.length, d.embedModel, Date.now())
      const insert = this.db.prepare('INSERT INTO kb_chunks (document_id, ord, page, section, text, embedding) VALUES (?, ?, ?, ?, ?, ?)')
      const fts = this.db.prepare('INSERT INTO kb_chunks_fts (rowid, text) VALUES (?, ?)')
      for (const c of chunks) {
        const r = insert.run(id, c.ord, c.page, c.section, c.text, c.embedding)
        fts.run(Number(r.lastInsertRowid), `${d.relPath}\n${c.text}`)
      }
      return this.document(id)
    })
  }

  saveError(d: { folderId: string; collectionId: string; relPath: string; size: number; mtimeMs: number }, error: string) {
    transaction(this.db, () => {
      const prev = this.db.prepare('SELECT id FROM kb_documents WHERE folder_id = ? AND rel_path = ?').get(d.folderId, d.relPath) as { id: string } | undefined
      if (prev) this.clearChunks(prev.id)
      this.db
        .prepare(
          `INSERT INTO kb_documents (id, collection_id, folder_id, rel_path, size, mtime_ms, status, error, chunks, indexed_at) VALUES (?, ?, ?, ?, ?, ?, 'error', ?, 0, ?)
           ON CONFLICT (folder_id, rel_path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms, status = 'error', error = excluded.error, chunks = 0, pages = NULL, indexed_at = excluded.indexed_at`,
        )
        .run(prev?.id ?? randomUUID(), d.collectionId, d.folderId, d.relPath, d.size, d.mtimeMs, error.slice(0, 500), Date.now())
    })
  }

  deleteDocument(id: string) {
    transaction(this.db, () => {
      this.clearChunks(id)
      this.db.prepare('DELETE FROM kb_documents WHERE id = ?').run(id)
    })
  }

  private clearChunks(documentId: string) {
    this.db.prepare('DELETE FROM kb_chunks_fts WHERE rowid IN (SELECT id FROM kb_chunks WHERE document_id = ?)').run(documentId)
    this.db.prepare('DELETE FROM kb_chunks WHERE document_id = ?').run(documentId)
  }

  /** Búsqueda por palabras (BM25) dentro de las bases indicadas. */
  keywordSearch(collectionIds: string[], query: string, limit: number): number[] {
    if (!collectionIds.length) return []
    const marks = collectionIds.map(() => '?').join(',')
    try {
      const rows = this.db
        .prepare(
          `SELECT f.rowid AS id FROM kb_chunks_fts f JOIN kb_chunks k ON k.id = f.rowid JOIN kb_documents d ON d.id = k.document_id
           WHERE kb_chunks_fts MATCH ? AND d.collection_id IN (${marks}) ORDER BY bm25(kb_chunks_fts) LIMIT ?`,
        )
        .all(query, ...collectionIds, limit) as { id: number }[]
      return rows.map((r) => r.id)
    } catch {
      return [] // consulta FTS no válida: se queda solo la búsqueda por significado
    }
  }

  /** Vectores de las bases indicadas (para la búsqueda por significado, que se hace en memoria). */
  vectors(collectionIds: string[]): { id: number; embedding: Uint8Array }[] {
    if (!collectionIds.length) return []
    const marks = collectionIds.map(() => '?').join(',')
    return this.db.prepare(`SELECT k.id, k.embedding FROM kb_chunks k JOIN kb_documents d ON d.id = k.document_id WHERE d.collection_id IN (${marks})`).all(...collectionIds) as {
      id: number
      embedding: Uint8Array
    }[]
  }

  chunks(ids: number[]): ChunkHit[] {
    if (!ids.length) return []
    const marks = ids.map(() => '?').join(',')
    const rows = this.db
      .prepare(`SELECT k.id, k.document_id, k.page, k.section, k.text, d.collection_id, d.rel_path FROM kb_chunks k JOIN kb_documents d ON d.id = k.document_id WHERE k.id IN (${marks})`)
      .all(...ids) as Record<string, unknown>[]
    const byId = new Map(
      rows.map((r) => [
        r['id'] as number,
        { id: r['id'] as number, documentId: r['document_id'] as string, collectionId: r['collection_id'] as string, relPath: r['rel_path'] as string, page: (r['page'] as number | null) ?? null, section: (r['section'] as string | null) ?? null, text: r['text'] as string },
      ]),
    )
    return ids.map((id) => byId.get(id)).filter((x): x is ChunkHit => !!x)
  }
}

/* ───────────── Conversaciones del asistente ───────────── */

const convOf = (r: Record<string, unknown>): AssistantConversation => ({
  id: r['id'] as string,
  title: r['title'] as string,
  collectionIds: JSON.parse(r['collections_json'] as string) as string[],
  createdAt: r['created_at'] as number,
  updatedAt: r['updated_at'] as number,
  messageCount: (r['message_count'] as number) ?? 0,
  private: false,
})

const msgOf = (r: Record<string, unknown>): AssistantMessage => ({
  id: r['id'] as string,
  conversationId: r['conversation_id'] as string,
  role: r['role'] as 'user' | 'assistant',
  blocks: JSON.parse(r['blocks_json'] as string) as unknown[],
  model: (r['model'] as string | null) ?? null,
  metrics: r['metrics_json'] ? (JSON.parse(r['metrics_json'] as string) as ChatMetricsRow) : null,
  createdAt: r['created_at'] as number,
})

const CONV_SELECT = 'SELECT c.*, (SELECT COUNT(*) FROM assistant_messages m WHERE m.conversation_id = c.id) AS message_count FROM assistant_conversations c'

export class AssistantRepo {
  constructor(private readonly db: Db) {}

  list(): AssistantConversation[] {
    return (this.db.prepare(`${CONV_SELECT} ORDER BY c.updated_at DESC`).all() as Record<string, unknown>[]).map(convOf)
  }

  get(id: string): AssistantConversation {
    const r = this.db.prepare(`${CONV_SELECT} WHERE c.id = ?`).get(id) as Record<string, unknown> | undefined
    if (!r) throw new AppError('NOT_FOUND', 'Conversación no encontrada')
    return convOf(r)
  }

  create(collectionIds: string[], title = 'Nueva conversación'): AssistantConversation {
    const id = randomUUID()
    const now = Date.now()
    this.db.prepare('INSERT INTO assistant_conversations (id, title, collections_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, title, JSON.stringify(collectionIds), now, now)
    return this.get(id)
  }

  update(id: string, patch: { title?: string; collectionIds?: string[] }): AssistantConversation {
    this.get(id)
    if (patch.title !== undefined) this.db.prepare('UPDATE assistant_conversations SET title = ? WHERE id = ?').run(patch.title.trim(), id)
    if (patch.collectionIds !== undefined) this.db.prepare('UPDATE assistant_conversations SET collections_json = ? WHERE id = ?').run(JSON.stringify(patch.collectionIds), id)
    return this.get(id)
  }

  delete(id: string) {
    this.db.prepare('DELETE FROM assistant_conversations WHERE id = ?').run(id)
  }

  messages(conversationId: string): AssistantMessage[] {
    return (this.db.prepare('SELECT * FROM assistant_messages WHERE conversation_id = ? ORDER BY created_at, rowid').all(conversationId) as Record<string, unknown>[]).map(msgOf)
  }

  addMessage(conversationId: string, role: 'user' | 'assistant', blocks: unknown[], model: string | null = null, metrics: ChatMetricsRow | null = null): AssistantMessage {
    this.get(conversationId)
    const id = randomUUID()
    const now = Date.now()
    transaction(this.db, () => {
      this.db.prepare('INSERT INTO assistant_messages (id, conversation_id, role, blocks_json, model, metrics_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, conversationId, role, JSON.stringify(blocks), model, metrics ? JSON.stringify(metrics) : null, now)
      this.db.prepare('UPDATE assistant_conversations SET updated_at = ? WHERE id = ?').run(now, conversationId)
    })
    return msgOf(this.db.prepare('SELECT * FROM assistant_messages WHERE id = ?').get(id) as Record<string, unknown>)
  }
}
