import { randomUUID } from 'node:crypto'
import type { AttachmentRow, BenchRecord, ChatMetricsRow, ConversationRow, Hardware, MessageRow } from '@shared/ipc/contract'
import type { AttachmentKind, AttachmentMetaInfo, AttachmentStatus } from '@shared/attachments'
import type { BenchResult } from '@shared/agent/host'
import { AppError } from '@core/errors'
import { transaction, type Db } from './database'

/* ───────────── Proyectos ───────────── */

export interface ProjectRecord {
  id: string
  name: string
  rootPath: string
  createdAt: number
  lastOpenedAt: number
  hidden: boolean
}

type ProjectDbRow = { id: string; name: string; root_path: string; created_at: number; last_opened_at: number; hidden: number }
const toProject = (r: ProjectDbRow): ProjectRecord => ({
  id: r.id,
  name: r.name,
  rootPath: r.root_path,
  createdAt: r.created_at,
  lastOpenedAt: r.last_opened_at,
  hidden: r.hidden === 1,
})

export function rootKey(rootPath: string, platform: NodeJS.Platform = process.platform): string {
  const p = rootPath.replace(/[\\/]+$/, '')
  return platform === 'win32' ? p.toLowerCase() : p
}

export class ProjectsRepo {
  constructor(
    private readonly db: Db,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  listRecent(limit = 20): ProjectRecord[] {
    return (this.db.prepare('SELECT * FROM projects WHERE hidden = 0 ORDER BY last_opened_at DESC LIMIT ?').all(limit) as ProjectDbRow[]).map(toProject)
  }

  get(id: string): ProjectRecord {
    const r = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectDbRow | undefined
    if (!r) throw new AppError('NOT_FOUND', 'Proyecto no encontrado')
    return toProject(r)
  }

  /** Registra o reutiliza el proyecto de esa carpeta y lo marca como abierto ahora. */
  touchByRoot(rootPath: string, name: string): ProjectRecord {
    const key = rootKey(rootPath, this.platform)
    const now = Date.now()
    const existing = this.db.prepare('SELECT * FROM projects WHERE root_key = ?').get(key) as ProjectDbRow | undefined
    if (existing) {
      this.db.prepare('UPDATE projects SET last_opened_at = ?, hidden = 0, root_path = ? WHERE id = ?').run(now, rootPath, existing.id)
      return this.get(existing.id)
    }
    const id = randomUUID()
    this.db
      .prepare('INSERT INTO projects (id, name, root_path, root_key, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, name, rootPath, key, now, now)
    return this.get(id)
  }

  /** Proyecto ya registrado con esa carpeta (comparación normalizada), o null. */
  findByRoot(rootPath: string): ProjectRecord | null {
    const r = this.db.prepare('SELECT * FROM projects WHERE root_key = ?').get(rootKey(rootPath, this.platform)) as ProjectDbRow | undefined
    return r ? toProject(r) : null
  }

  touch(id: string): ProjectRecord {
    this.db.prepare('UPDATE projects SET last_opened_at = ?, hidden = 0 WHERE id = ?').run(Date.now(), id)
    return this.get(id)
  }

  rename(id: string, name: string): ProjectRecord {
    const res = this.db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(name.trim(), id)
    if (res.changes === 0) throw new AppError('NOT_FOUND', 'Proyecto no encontrado')
    return this.get(id)
  }

  /** Ajustes propios del proyecto (columna settings_json): p. ej. carpetas autorizadas. */
  settings(id: string): Record<string, unknown> {
    const r = this.db.prepare('SELECT settings_json FROM projects WHERE id = ?').get(id) as { settings_json: string } | undefined
    if (!r) throw new AppError('NOT_FOUND', 'Proyecto no encontrado')
    try {
      const v = JSON.parse(r.settings_json) as unknown
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }

  setSetting(id: string, key: string, value: unknown): void {
    const next = { ...this.settings(id), [key]: value }
    this.db.prepare('UPDATE projects SET settings_json = ? WHERE id = ?').run(JSON.stringify(next), id)
  }

  /** Quita de recientes conservando conversaciones (vuelve a aparecer si se reabre la carpeta). */
  hide(id: string): void {
    this.db.prepare('UPDATE projects SET hidden = 1 WHERE id = ?').run(id)
  }
}

/* ───────────── Conversaciones y mensajes ───────────── */

type ConvDbRow = { id: string; project_id: string; title: string; created_at: number; updated_at: number; message_count: number }
const toConv = (r: ConvDbRow): ConversationRow => ({
  id: r.id,
  projectId: r.project_id,
  title: r.title,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  messageCount: r.message_count,
})

type MsgDbRow = { id: string; conversation_id: string; role: MessageRow['role']; blocks_json: string; model: string | null; metrics_json: string | null; created_at: number }
const toMsg = (r: MsgDbRow): MessageRow => ({
  id: r.id,
  conversationId: r.conversation_id,
  role: r.role,
  blocks: JSON.parse(r.blocks_json) as unknown[],
  model: r.model,
  metrics: r.metrics_json ? (JSON.parse(r.metrics_json) as ChatMetricsRow) : null,
  createdAt: r.created_at,
})

const CONV_SELECT = `SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count FROM conversations c`

export class ConversationsRepo {
  constructor(private readonly db: Db) {}

  list(projectId: string): ConversationRow[] {
    return (this.db.prepare(`${CONV_SELECT} WHERE c.project_id = ? AND c.archived = 0 ORDER BY c.updated_at DESC`).all(projectId) as ConvDbRow[]).map(toConv)
  }

  get(id: string): ConversationRow {
    const r = this.db.prepare(`${CONV_SELECT} WHERE c.id = ?`).get(id) as ConvDbRow | undefined
    if (!r) throw new AppError('NOT_FOUND', 'Conversación no encontrada')
    return toConv(r)
  }

  create(projectId: string, title = 'Nueva conversación'): ConversationRow {
    const id = randomUUID()
    const now = Date.now()
    this.db.prepare('INSERT INTO conversations (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, projectId, title, now, now)
    return this.get(id)
  }

  rename(id: string, title: string): ConversationRow {
    const res = this.db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title.trim(), id)
    if (res.changes === 0) throw new AppError('NOT_FOUND', 'Conversación no encontrada')
    return this.get(id)
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id)
  }

  messages(conversationId: string): MessageRow[] {
    return (this.db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid').all(conversationId) as MsgDbRow[]).map(toMsg)
  }

  addMessage(conversationId: string, role: MessageRow['role'], blocks: unknown[], model: string | null = null, metrics: ChatMetricsRow | null = null): MessageRow {
    this.get(conversationId)
    const id = randomUUID()
    const now = Date.now()
    transaction(this.db, () => {
      this.db
        .prepare('INSERT INTO messages (id, conversation_id, role, blocks_json, model, metrics_json, tokens_in, tokens_out, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, conversationId, role, JSON.stringify(blocks), model, metrics ? JSON.stringify(metrics) : null, metrics?.promptTokens ?? null, metrics?.evalTokens ?? null, now)
      this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId)
    })
    return toMsg(this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MsgDbRow)
  }
}

/* ───────────── Ajustes ───────────── */

const MAX_SETTING_BYTES = 64 * 1024

export class SettingsRepo {
  constructor(private readonly db: Db) {}

  getAll(): Record<string, unknown> {
    const rows = this.db.prepare('SELECT key, value_json FROM settings').all() as { key: string; value_json: string }[]
    return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value_json) as unknown]))
  }

  get<T>(key: string, fallback: T): T {
    const r = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as { value_json: string } | undefined
    return r ? (JSON.parse(r.value_json) as T) : fallback
  }

  set(key: string, value: unknown): void {
    const json = JSON.stringify(value ?? null)
    if (json.length > MAX_SETTING_BYTES) throw new AppError('INVALID_INPUT', `El ajuste "${key}" es demasiado grande`)
    this.db
      .prepare('INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at')
      .run(key, json, Date.now())
  }
}

/* ───────────── Banco de pruebas ───────────── */

type BenchDbRow = { id: string; model: string; created_at: number; ollama_version: string | null; hardware_json: string; result_json: string }

export class BenchRepo {
  constructor(private readonly db: Db) {}

  add(result: BenchResult, hardware: Hardware, ollamaVersion: string | null): BenchRecord {
    const id = randomUUID()
    const now = Date.now()
    this.db
      .prepare('INSERT INTO benchmarks (id, model, created_at, ollama_version, hardware_json, result_json) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, result.model, now, ollamaVersion, JSON.stringify(hardware), JSON.stringify(result))
    return { id, createdAt: now, ollamaVersion, hardware, result }
  }

  list(limit = 50): BenchRecord[] {
    return (this.db.prepare('SELECT * FROM benchmarks ORDER BY created_at DESC LIMIT ?').all(limit) as BenchDbRow[]).map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      ollamaVersion: r.ollama_version,
      hardware: JSON.parse(r.hardware_json) as Hardware,
      result: JSON.parse(r.result_json) as BenchResult,
    }))
  }
}

/* ───────────── Agente: tareas, cambios y reglas de permiso ───────────── */

export interface FileChangeRecord {
  taskId: string
  projectId: string
  rel: string
  kind: 'create' | 'modify' | 'delete'
  beforeHash: string | null
  afterHash: string | null
  additions: number
  deletions: number
  status: 'pending' | 'accepted' | 'rejected'
}

type ChangeDbRow = { task_id: string; project_id: string; rel_path: string; kind: FileChangeRecord['kind']; before_hash: string | null; after_hash: string | null; additions: number; deletions: number; status: FileChangeRecord['status'] }
const toChange = (r: ChangeDbRow): FileChangeRecord => ({ taskId: r.task_id, projectId: r.project_id, rel: r.rel_path, kind: r.kind, beforeHash: r.before_hash, afterHash: r.after_hash, additions: r.additions, deletions: r.deletions, status: r.status })

export class AgentRepo {
  constructor(private readonly db: Db) {}

  startTask(id: string, conversationId: string, projectId: string, model: string) {
    this.db.prepare("INSERT INTO agent_tasks (id, conversation_id, project_id, model, status, started_at) VALUES (?, ?, ?, ?, 'running', ?)").run(id, conversationId, projectId, model, Date.now())
  }

  finishTask(id: string, status: 'completed' | 'failed' | 'cancelled', steps: number, error: string | null) {
    this.db.prepare('UPDATE agent_tasks SET status = ?, finished_at = ?, steps = ?, error = ? WHERE id = ?').run(status, Date.now(), steps, error, id)
  }

  /** Las tareas que quedaron "running" al cerrarse la app se marcan como canceladas, y queda constancia en su registro. */
  closeOrphans() {
    const now = Date.now()
    const orphans = this.db.prepare("SELECT id FROM agent_tasks WHERE status = 'running'").all() as { id: string }[]
    for (const { id } of orphans) this.addEvent(id, { type: 'task.cancelled', ts: now, reason: 'La aplicación se cerró mientras la tarea estaba en curso.' })
    this.db.prepare("UPDATE agent_tasks SET status = 'cancelled', finished_at = ? WHERE status = 'running'").run(now)
  }

  /* Registro de actividad: cada AgentEvent real, en orden */
  addEvent(taskId: string, event: { type: string; ts: number; [k: string]: unknown }) {
    const next = (this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM activity_events WHERE task_id = ?').get(taskId) as { n: number }).n
    this.db.prepare('INSERT INTO activity_events (task_id, seq, type, payload_json, ts) VALUES (?, ?, ?, ?, ?)').run(taskId, next, event.type, JSON.stringify(event), event.ts)
  }

  events(taskId: string): unknown[] {
    return (this.db.prepare('SELECT payload_json FROM activity_events WHERE task_id = ? ORDER BY seq').all(taskId) as { payload_json: string }[]).map((r) => JSON.parse(r.payload_json) as unknown)
  }

  task(taskId: string): { id: string; conversationId: string; model: string; status: string; startedAt: number; finishedAt: number | null } | null {
    const r = this.db.prepare('SELECT id, conversation_id, model, status, started_at, finished_at FROM agent_tasks WHERE id = ?').get(taskId) as
      | { id: string; conversation_id: string; model: string; status: string; started_at: number; finished_at: number | null }
      | undefined
    return r ? { id: r.id, conversationId: r.conversation_id, model: r.model, status: r.status, startedAt: r.started_at, finishedAt: r.finished_at } : null
  }

  latestTask(conversationId: string): string | null {
    const r = this.db.prepare('SELECT id FROM agent_tasks WHERE conversation_id = ? ORDER BY started_at DESC LIMIT 1').get(conversationId) as { id: string } | undefined
    return r?.id ?? null
  }

  /** Un archivo tocado varias veces en la tarea conserva su estado original y actualiza el final. */
  upsertChange(c: Omit<FileChangeRecord, 'status'>) {
    this.db
      .prepare(
        `INSERT INTO file_changes (id, task_id, project_id, rel_path, kind, before_hash, after_hash, additions, deletions, status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
         ON CONFLICT (task_id, rel_path) DO UPDATE SET kind = excluded.kind, after_hash = excluded.after_hash, additions = excluded.additions, deletions = excluded.deletions, status = 'pending', updated_at = excluded.updated_at`,
      )
      .run(randomUUID(), c.taskId, c.projectId, c.rel, c.kind, c.beforeHash, c.afterHash, c.additions, c.deletions, Date.now())
  }

  changes(taskId: string): FileChangeRecord[] {
    return (this.db.prepare('SELECT * FROM file_changes WHERE task_id = ? ORDER BY rel_path').all(taskId) as ChangeDbRow[]).map(toChange)
  }

  /** Cambios pendientes de revisar en un proyecto (el más reciente por archivo). */
  pendingForProject(projectId: string): FileChangeRecord[] {
    return (
      this.db
        .prepare(
          `SELECT fc.* FROM file_changes fc
           JOIN (SELECT rel_path, MAX(updated_at) AS u FROM file_changes WHERE project_id = ? AND status = 'pending' GROUP BY rel_path) last
             ON last.rel_path = fc.rel_path AND last.u = fc.updated_at
           WHERE fc.project_id = ? AND fc.status = 'pending' ORDER BY fc.rel_path`,
        )
        .all(projectId, projectId) as ChangeDbRow[]
    ).map(toChange)
  }

  setChangeStatus(taskId: string, rel: string, status: FileChangeRecord['status']) {
    this.db.prepare('UPDATE file_changes SET status = ?, updated_at = ? WHERE task_id = ? AND rel_path = ?').run(status, Date.now(), taskId, rel)
  }

  rules(projectId: string): { id: string; action: string; pattern: string; createdAt: number }[] {
    return (this.db.prepare('SELECT id, action, pattern, created_at FROM permission_rules WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as { id: string; action: string; pattern: string; created_at: number }[]).map((r) => ({
      id: r.id,
      action: r.action,
      pattern: r.pattern,
      createdAt: r.created_at,
    }))
  }

  addRule(projectId: string, action: string, pattern: string) {
    this.db.prepare('INSERT OR IGNORE INTO permission_rules (id, project_id, action, pattern, created_at) VALUES (?, ?, ?, ?, ?)').run(randomUUID(), projectId, action, pattern, Date.now())
  }

  deleteRule(id: string) {
    this.db.prepare('DELETE FROM permission_rules WHERE id = ?').run(id)
  }
}

/* ───────────── Adjuntos ───────────── */

export interface AttachmentRecord extends Omit<AttachmentRow, 'thumb'> {
  sha256: string
}

type AttDbRow = { id: string; sha256: string; file_name: string; ext: string; kind: string; size: number; status: string; error: string | null; meta_json: string; created_at: number }
const toAtt = (r: AttDbRow): AttachmentRecord => ({
  id: r.id,
  sha256: r.sha256,
  name: r.file_name,
  ext: r.ext,
  kind: r.kind as AttachmentKind,
  size: r.size,
  status: r.status as AttachmentStatus,
  error: r.error,
  meta: JSON.parse(r.meta_json) as AttachmentMetaInfo,
  createdAt: r.created_at,
})

export class AttachmentsRepo {
  constructor(private readonly db: Db) {}

  create(a: { sha256: string; name: string; ext: string; kind: AttachmentKind; size: number; status: AttachmentStatus; error?: string | null; meta?: AttachmentMetaInfo }): AttachmentRecord {
    const id = randomUUID()
    this.db
      .prepare('INSERT INTO attachments (id, sha256, file_name, ext, kind, size, status, error, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, a.sha256, a.name, a.ext, a.kind, a.size, a.status, a.error ?? null, JSON.stringify(a.meta ?? {}), Date.now())
    return this.get(id)
  }

  get(id: string): AttachmentRecord {
    const r = this.db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as AttDbRow | undefined
    if (!r) throw new AppError('NOT_FOUND', 'El adjunto no existe')
    return toAtt(r)
  }

  byIds(ids: string[]): AttachmentRecord[] {
    if (!ids.length) return []
    const rows = this.db.prepare(`SELECT * FROM attachments WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as AttDbRow[]
    const map = new Map(rows.map((r) => [r.id, toAtt(r)]))
    return ids.map((id) => map.get(id)).filter((a): a is AttachmentRecord => !!a)
  }

  /** Otra fila (ya procesada) con el mismo contenido: se reutiliza su extracción. */
  readyWithHash(sha256: string): AttachmentRecord | null {
    const r = this.db.prepare("SELECT * FROM attachments WHERE sha256 = ? AND status = 'ready' ORDER BY created_at DESC LIMIT 1").get(sha256) as AttDbRow | undefined
    return r ? toAtt(r) : null
  }

  update(id: string, patch: { kind?: AttachmentKind; status: AttachmentStatus; error?: string | null; meta?: AttachmentMetaInfo }) {
    const cur = this.get(id)
    this.db.prepare('UPDATE attachments SET kind = ?, status = ?, error = ?, meta_json = ? WHERE id = ?').run(patch.kind ?? cur.kind, patch.status, patch.error ?? null, JSON.stringify(patch.meta ?? cur.meta), id)
    return this.get(id)
  }

  ready(): AttachmentRecord[] {
    return (this.db.prepare("SELECT * FROM attachments WHERE status = 'ready'").all() as AttDbRow[]).map(toAtt)
  }

  /** Los que se quedaron a medias al cerrar la app. */
  processing(): AttachmentRecord[] {
    return (this.db.prepare("SELECT * FROM attachments WHERE status = 'processing'").all() as AttDbRow[]).map(toAtt)
  }

  link(messageId: string, ids: string[]) {
    transaction(this.db, () => {
      const st = this.db.prepare('INSERT OR IGNORE INTO message_attachments (message_id, attachment_id, position) VALUES (?, ?, ?)')
      ids.forEach((id, i) => st.run(messageId, id, i))
    })
  }

  isLinked(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM message_attachments WHERE attachment_id = ? LIMIT 1').get(id)
  }

  /** Adjuntos enviados en una conversación, en orden. */
  forConversation(conversationId: string): AttachmentRecord[] {
    const rows = this.db
      .prepare(
        `SELECT a.* FROM attachments a JOIN message_attachments ma ON ma.attachment_id = a.id JOIN messages m ON m.id = ma.message_id
         WHERE m.conversation_id = ? ORDER BY m.created_at, ma.position`,
      )
      .all(conversationId) as AttDbRow[]
    return rows.map(toAtt)
  }

  delete(id: string) {
    this.db.prepare('DELETE FROM attachments WHERE id = ?').run(id)
  }

  /** Adjuntos subidos pero nunca enviados y más antiguos que `olderThan` (se limpian al arrancar). */
  orphans(olderThan: number): AttachmentRecord[] {
    return (this.db.prepare('SELECT * FROM attachments a WHERE created_at < ? AND NOT EXISTS (SELECT 1 FROM message_attachments ma WHERE ma.attachment_id = a.id)').all(olderThan) as AttDbRow[]).map(toAtt)
  }

  hashInUse(sha256: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM attachments WHERE sha256 = ? LIMIT 1').get(sha256)
  }

  stats(): { count: number; bytes: number } {
    const r = this.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS b FROM (SELECT sha256, MAX(size) AS size FROM attachments GROUP BY sha256)').get() as { n: number; b: number }
    return { count: r.n, bytes: r.b }
  }
}

