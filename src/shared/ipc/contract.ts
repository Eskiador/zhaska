/**
 * Contrato IPC único (ARCHITECTURE §4.2). Cada canal declara su petición y su respuesta con zod.
 * - main valida la petición antes de ejecutar el handler;
 * - preload solo expone los canales listados aquí;
 * - el renderer obtiene tipos exactos con `Req<C>` / `Res<C>`.
 */
import { z } from 'zod'
import { ATTACHMENT_LIMITS } from '../attachments'

export const Id = z.string().min(1).max(80)
/** Ruta relativa a la raíz del proyecto, con "/" como separador. "" = raíz. La valida PathGuard en main. */
export const RelPath = z.string().max(1024)

export const ProjectSchema = z.object({
  id: Id,
  name: z.string(),
  rootPath: z.string(),
  createdAt: z.number(),
  lastOpenedAt: z.number(),
  exists: z.boolean(),
  isGit: z.boolean(),
  branch: z.string().nullable(),
})

export const DirEntrySchema = z.object({
  name: z.string(),
  rel: z.string(),
  kind: z.enum(['file', 'dir']),
  size: z.number().optional(),
  /** Oculto por defecto (node_modules, .git, dist…) */
  ignored: z.boolean(),
  symlink: z.boolean(),
})

export const FileContentSchema = z.object({
  rel: z.string(),
  content: z.string(),
  encoding: z.enum(['utf8', 'utf8-bom']),
  eol: z.enum(['LF', 'CRLF']),
  size: z.number(),
  mtimeMs: z.number(),
  /** true si no se cargó el contenido por ser binario o demasiado grande */
  unsupported: z.enum(['binary', 'too-large']).nullable(),
})

export const ConversationSchema = z.object({
  id: Id,
  projectId: Id,
  title: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  messageCount: z.number(),
})

export const ChatMetricsSchema = z.object({
  promptTokens: z.number(),
  evalTokens: z.number(),
  loadMs: z.number(),
  promptMs: z.number(),
  evalMs: z.number(),
  totalMs: z.number(),
  tokensPerSec: z.number(),
  prefillTokensPerSec: z.number(),
})

export const AttachmentKindSchema = z.enum(['pdf', 'doc', 'sheet', 'image', 'code', 'archive', 'text', 'other'])
export const AttachmentMetaSchema = z.object({
  chars: z.number().optional(),
  pages: z.number().optional(),
  sheets: z.array(z.object({ name: z.string(), rows: z.number(), cols: z.number() })).optional(),
  ocr: z.object({ pages: z.number(), confidence: z.number() }).optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  encoding: z.string().optional(),
  entries: z.number().optional(),
  rejected: z.number().optional(),
  hasThumb: z.boolean().optional(),
  hasVision: z.boolean().optional(),
  warnings: z.array(z.string()).optional(),
})
/** Adjunto (Fase 8). `thumb` = miniatura JPEG como data URL (imágenes). */
export const AttachmentSchema = z.object({
  id: Id,
  name: z.string(),
  ext: z.string(),
  kind: AttachmentKindSchema,
  size: z.number(),
  status: z.enum(['processing', 'ready', 'error']),
  error: z.string().nullable(),
  meta: AttachmentMetaSchema,
  thumb: z.string().nullable(),
  createdAt: z.number(),
})
export const AttachmentPreviewSchema = z.object({
  text: z.string().nullable(),
  truncated: z.boolean(),
  sheets: z.array(z.object({ name: z.string(), rows: z.array(z.array(z.string())) })).nullable(),
  entries: z.array(z.object({ path: z.string(), size: z.number(), status: z.enum(['ok', 'rejected', 'skipped']), reason: z.string().optional() })).nullable(),
  /** Imagen a tamaño de vista previa (data URL) */
  image: z.string().nullable(),
})
const AttachmentIds = z.array(Id).max(ATTACHMENT_LIMITS.perMessage).default([])

export const MessageSchema = z.object({
  id: Id,
  conversationId: Id,
  role: z.enum(['user', 'assistant', 'tool', 'system']),
  /** Bloques del mensaje (texto, código, chips, cambios) serializados como JSON. */
  blocks: z.array(z.unknown()),
  model: z.string().nullable(),
  metrics: ChatMetricsSchema.nullable(),
  createdAt: z.number(),
})

/** Nombre de modelo de Ollama: familia[:etiqueta], p. ej. gemma4:12b-it-qat */
export const ModelName = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._\-/]*(:[a-zA-Z0-9._\-]+)?$/, 'Nombre de modelo no válido')

export const OllamaStatusSchema = z.object({
  state: z.enum(['checking', 'connected', 'starting', 'stopped', 'not-installed', 'error']),
  host: z.string(),
  version: z.string().nullable(),
  binaryPath: z.string().nullable(),
  /** true si ZHASKA arrancó el servidor (solo entonces puede detenerlo) */
  managed: z.boolean(),
  startedAt: z.number().nullable(),
  error: z.string().nullable(),
  installing: z.enum(['downloading', 'verifying', 'installing']).nullable(),
})

export const LoadedModelSchema = z.object({
  name: z.string(),
  sizeBytes: z.number(),
  vramBytes: z.number(),
  contextLength: z.number().nullable(),
  expiresAt: z.number().nullable(),
})

export const HardwareSchema = z.object({
  gpu: z.string().nullable(),
  accel: z.enum(['cuda', 'metal', 'cpu']),
  vramGB: z.number().nullable(),
  unified: z.boolean(),
  ramGB: z.number(),
  freeRamGB: z.number(),
  diskFreeGB: z.number().nullable(),
  modelsDir: z.string(),
})

export const InstalledModelSchema = z.object({
  name: z.string(),
  sizeBytes: z.number(),
  family: z.string().nullable(),
  parameterSize: z.string().nullable(),
  quantization: z.string().nullable(),
  contextLength: z.number().nullable(),
  capabilities: z.array(z.string()),
  modifiedAt: z.number(),
})

export const PullProgressSchema = z.object({
  jobId: Id,
  name: z.string(),
  phase: z.enum(['manifest', 'layers', 'verify', 'register', 'done', 'error', 'cancelled']),
  completed: z.number(),
  total: z.number(),
  bytesPerSec: z.number(),
  error: z.string().nullable(),
  /** De dónde se descarga: servidor de Ollama o Hugging Face (misma versión oficial de Google) */
  source: z.enum(['ollama', 'huggingface']),
  note: z.string().nullable(),
})

export const BenchResultSchema = z.object({
  model: z.string(),
  numCtx: z.number(),
  loadMs: z.number(),
  genTokensPerSec: z.number(),
  prefillTokensPerSec: z.number(),
  prefillTokens: z.number(),
  gpuPercent: z.number().nullable(),
  toolsNative: z.object({ valid: z.number(), total: z.number() }).nullable(),
  toolsJson: z.object({ valid: z.number(), total: z.number() }),
  capabilities: z.array(z.string()),
})

export const BenchRecordSchema = z.object({
  id: Id,
  createdAt: z.number(),
  ollamaVersion: z.string().nullable(),
  hardware: HardwareSchema,
  result: BenchResultSchema,
})

export const BackupSchema = z.object({ file: z.string(), size: z.number(), createdAt: z.number(), reason: z.string() })

/** Resumen de una base de datos (copia o importación) antes de usarla. */
const DbSummarySchema = z.object({ schemaVersion: z.number(), projects: z.number(), conversations: z.number(), messages: z.number(), attachments: z.number() })
export const ImportSummarySchema = DbSummarySchema.extend({
  token: Id,
  fileName: z.string(),
  createdAt: z.number(),
  appVersion: z.string().nullable(),
  attachmentFiles: z.number(),
  bytes: z.number(),
})
export const LastOperationSchema = z.object({ kind: z.enum(['restore', 'import']), label: z.string(), ok: z.boolean(), error: z.string().optional(), safetyBackup: z.string().optional(), at: z.number() })

export const AppInfoSchema = z.object({
  version: z.string(),
  platform: z.string(),
  arch: z.string(),
  electron: z.string(),
  chrome: z.string(),
  node: z.string(),
  sqlite: z.string(),
  userDataPath: z.string(),
  dbPath: z.string(),
  schemaVersion: z.number(),
  defaultProjectsDir: z.string(),
  /** App instalada (empaquetada) o en desarrollo */
  packaged: z.boolean(),
  /** Versión anterior si este es el primer arranque tras actualizar */
  updatedFrom: z.string().nullable(),
})

/** Estado de las actualizaciones (electron-updater, Fase 10). */
export const UpdateStatusSchema = z.object({
  state: z.enum(['unconfigured', 'idle', 'checking', 'available', 'not-available', 'downloading', 'downloaded', 'error']),
  current: z.string(),
  version: z.string().optional(),
  releaseDate: z.string().optional(),
  notes: z.string().optional(),
  percent: z.number().optional(),
  bytesPerSec: z.number().optional(),
  total: z.number().optional(),
  transferred: z.number().optional(),
  checkedAt: z.number().optional(),
  message: z.string().optional(),
  error: z.string().optional(),
})

/** Rendimiento (Fase 11): hitos del arranque y memoria de cada proceso de la app (sin Ollama). */
export const MetricsSchema = z.object({
  processStartedAt: z.number(),
  startup: z.record(z.string(), z.number()),
  processes: z.array(z.object({ type: z.string(), name: z.string(), pid: z.number(), memoryMB: z.number(), cpu: z.number() })),
  totalMB: z.number(),
  /** Reparto de memoria del proceso principal (MB): montón de JavaScript, memoria externa (búferes) y total */
  main: z.object({ heapMB: z.number(), externalMB: z.number(), rssMB: z.number() }),
})

/** Herramientas de desarrollo del sistema (solo se detectan e informan; Fase 10). */
export const DevToolsSchema = z.array(z.object({ id: z.enum(['node', 'python', 'git']), label: z.string(), version: z.string().nullable() }))

export const FileChangeSchema = z.object({
  taskId: Id,
  rel: z.string(),
  kind: z.enum(['create', 'modify', 'delete']),
  additions: z.number(),
  deletions: z.number(),
  status: z.enum(['pending', 'accepted', 'rejected']),
})

export const ActivityTaskSchema = z.object({
  taskId: Id,
  conversationId: Id,
  model: z.string(),
  status: z.enum(['running', 'completed', 'failed', 'cancelled']),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
  /** AgentEvent[] guardados, en orden */
  events: z.array(z.unknown()),
})

export const AgentStreamSchema = z.object({
  taskId: Id,
  conversationId: Id,
  kind: z.enum(['event', 'text', 'change', 'done']),
  /** AgentEvent (src/shared/agent/events.ts) */
  event: z.unknown().optional(),
  text: z.string().optional(),
  change: FileChangeSchema.optional(),
  message: MessageSchema.optional(),
})

/** Carpeta fuera del proyecto que el agente puede leer sin preguntar (nunca modificar). */
export const AuthorizedDirSchema = z.object({ path: z.string(), addedAt: z.number(), exists: z.boolean() })

export const TerminalSchema = z.object({ id: Id, projectId: Id, title: z.string(), shell: z.string(), alive: z.boolean() })

const none = z.undefined()

export const contract = {
  'app.info': { req: none, res: AppInfoSchema },
  'app.metrics': { req: none, res: MetricsSchema },
  'dialog.pickFolder': { req: z.object({ title: z.string().max(200).optional(), defaultPath: z.string().max(1024).optional() }), res: z.string().nullable() },

  'projects.list': { req: none, res: z.array(ProjectSchema) },
  'projects.open': { req: z.object({ id: Id }), res: ProjectSchema },
  'projects.openFolder': { req: z.object({ path: z.string().min(1).max(1024) }), res: ProjectSchema },
  'projects.create': {
    req: z.object({
      name: z.string().min(1).max(100),
      parentDir: z.string().min(1).max(1024),
      gitInit: z.boolean(),
      createGuide: z.boolean(),
      description: z.string().max(4000).optional(),
    }),
    res: ProjectSchema.extend({ warnings: z.array(z.string()) }),
  },
  'projects.createFromTemplate': {
    req: z.object({
      jobId: Id,
      name: z.string().min(1).max(100),
      parentDir: z.string().min(1).max(1024),
      template: z.enum(['react-vite', 'next']),
      gitInit: z.boolean(),
      createGuide: z.boolean(),
      description: z.string().max(4000).optional(),
      install: z.boolean(),
    }),
    res: ProjectSchema.extend({ warnings: z.array(z.string()) }),
  },
  'projects.clone': { req: z.object({ jobId: Id, url: z.string().min(1).max(2000), parentDir: z.string().min(1).max(1024), name: z.string().max(100).optional() }), res: ProjectSchema },
  'projects.rename': { req: z.object({ id: Id, name: z.string().min(1).max(100) }), res: ProjectSchema },
  'projects.forget': { req: z.object({ id: Id }), res: z.void() },
  'projects.close': { req: z.object({ id: Id }), res: z.void() },
  /** Carpetas autorizadas (solo lectura para el agente). Se añaden con el selector nativo que abre main. */
  'projects.authorizedDirs': { req: z.object({ projectId: Id }), res: z.array(AuthorizedDirSchema) },
  'projects.authorizeDir': { req: z.object({ projectId: Id }), res: z.array(AuthorizedDirSchema) },
  'projects.revokeDir': { req: z.object({ projectId: Id, path: z.string().min(1).max(1024) }), res: z.array(AuthorizedDirSchema) },

  'fs.list': { req: z.object({ projectId: Id, rel: RelPath }), res: z.array(DirEntrySchema) },
  'fs.read': { req: z.object({ projectId: Id, rel: RelPath }), res: FileContentSchema },
  'fs.write': {
    req: z.object({ projectId: Id, rel: RelPath, content: z.string().max(20 * 1024 * 1024), encoding: z.enum(['utf8', 'utf8-bom']), expectedMtimeMs: z.number().optional() }),
    res: z.object({ mtimeMs: z.number(), size: z.number() }),
  },
  'fs.create': { req: z.object({ projectId: Id, rel: RelPath, kind: z.enum(['file', 'dir']) }), res: z.void() },
  'fs.rename': { req: z.object({ projectId: Id, from: RelPath, to: RelPath }), res: z.void() },
  'fs.trash': { req: z.object({ projectId: Id, rel: RelPath }), res: z.void() },
  'fs.reveal': { req: z.object({ projectId: Id, rel: RelPath }), res: z.void() },
  /** «Buscar archivo» en todo el proyecto (índice en main, Fase 11) */
  'fs.findFiles': {
    req: z.object({ projectId: Id, query: z.string().max(200), limit: z.number().int().min(1).max(200).default(50) }),
    res: z.object({ files: z.array(z.string()), total: z.number(), truncated: z.boolean() }),
  },

  'conversations.list': { req: z.object({ projectId: Id }), res: z.array(ConversationSchema) },
  'conversations.create': { req: z.object({ projectId: Id, title: z.string().max(200).optional() }), res: ConversationSchema },
  'conversations.rename': { req: z.object({ id: Id, title: z.string().min(1).max(200) }), res: ConversationSchema },
  'conversations.delete': { req: z.object({ id: Id }), res: z.void() },
  'messages.list': { req: z.object({ conversationId: Id }), res: z.array(MessageSchema) },
  'messages.add': {
    req: z.object({ conversationId: Id, role: z.enum(['user', 'assistant']), blocks: z.array(z.unknown()).max(500), model: z.string().max(200).nullable().optional() }),
    res: MessageSchema,
  },

  'settings.getAll': { req: none, res: z.record(z.string(), z.unknown()) },
  'settings.set': { req: z.object({ key: z.string().min(1).max(100), value: z.unknown() }), res: z.void() },

  'ollama.status': { req: none, res: z.object({ status: OllamaStatusSchema, loaded: z.array(LoadedModelSchema) }) },
  'ollama.start': { req: none, res: OllamaStatusSchema },
  'ollama.stop': { req: none, res: z.void() },
  'ollama.install': { req: none, res: z.enum(['installed', 'opened-download']) },
  'ollama.logs': { req: none, res: z.array(z.string()) },
  'system.hardware': { req: none, res: HardwareSchema },
  'system.devTools': { req: none, res: DevToolsSchema },
  /** Requisitos del equipo para el asistente inicial (sistema, RAM) */
  'system.requirements': { req: none, res: z.object({ os: z.string(), osOk: z.boolean(), osNote: z.string(), arch: z.string(), archOk: z.boolean(), ramGB: z.number(), ramOk: z.boolean() }) },

  'models.list': { req: none, res: z.array(InstalledModelSchema) },
  'models.pull': { req: z.object({ name: ModelName }), res: z.object({ jobId: Id }) },
  'models.pulls': { req: none, res: z.array(PullProgressSchema) },
  'models.cancelPull': { req: z.object({ jobId: Id }), res: z.void() },
  'models.delete': { req: z.object({ name: ModelName }), res: z.void() },
  'models.load': { req: z.object({ name: ModelName }), res: z.void() },
  'models.unload': { req: z.object({ name: ModelName }), res: z.void() },
  'models.test': { req: z.object({ name: ModelName }), res: z.object({ reply: z.string(), totalMs: z.number(), tokensPerSec: z.number(), loadMs: z.number() }) },
  /** Prueba del asistente inicial: una llamada a herramienta real sobre un proyecto de ejemplo temporal */
  'models.toolTest': { req: z.object({ name: ModelName }), res: z.object({ ok: z.boolean(), called: z.string().nullable(), reply: z.string(), totalMs: z.number(), tokensPerSec: z.number(), note: z.string() }) },

  'chat.send': {
    req: z.object({ conversationId: Id, text: z.string().min(1).max(100_000), model: ModelName, attachmentIds: AttachmentIds }),
    res: z.object({ taskId: Id, message: MessageSchema, conversation: ConversationSchema }),
  },
  'chat.cancel': { req: z.object({ taskId: Id }), res: z.void() },

  /** Adjuntos: el renderer envía el contenido (nunca rutas), main lo guarda fuera del proyecto y lo procesa. */
  'attachments.upload': {
    req: z.object({ name: z.string().min(1).max(500), data: z.instanceof(Uint8Array).refine((b) => b.byteLength <= ATTACHMENT_LIMITS.fileBytes, 'Supera el límite de 50 MB') }),
    res: AttachmentSchema,
  },
  'attachments.get': { req: z.object({ ids: z.array(Id).max(500) }), res: z.array(AttachmentSchema) },
  'attachments.forConversation': { req: z.object({ conversationId: Id }), res: z.array(AttachmentSchema) },
  'attachments.remove': { req: z.object({ id: Id }), res: z.void() },
  'attachments.preview': { req: z.object({ id: Id }), res: AttachmentPreviewSchema },
  'chat.active': { req: none, res: z.array(z.object({ taskId: Id, conversationId: Id, text: z.string(), model: z.string() })) },

  'agent.start': {
    req: z.object({ conversationId: Id, text: z.string().min(1).max(100_000), model: ModelName, attachmentIds: AttachmentIds }),
    res: z.object({ taskId: Id, message: MessageSchema, conversation: ConversationSchema }),
  },
  'agent.cancel': { req: z.object({ taskId: Id }), res: z.void() },
  'agent.approve': { req: z.object({ taskId: Id, requestId: Id, decision: z.enum(['allow_once', 'allow_always', 'deny']) }), res: z.void() },
  'agent.pause': { req: z.object({ taskId: Id }), res: z.void() },
  'agent.resume': { req: z.object({ taskId: Id }), res: z.void() },
  'activity.task': { req: z.object({ taskId: Id }), res: ActivityTaskSchema.nullable() },
  'activity.latest': { req: z.object({ conversationId: Id }), res: ActivityTaskSchema.nullable() },
  'agent.active': { req: none, res: z.array(z.object({ taskId: Id, conversationId: Id, text: z.string(), model: z.string() })) },
  'changes.list': { req: z.object({ taskId: Id }), res: z.array(FileChangeSchema) },
  'changes.accept': { req: z.object({ taskId: Id, rel: RelPath.optional() }), res: z.array(FileChangeSchema) },
  'changes.reject': { req: z.object({ taskId: Id, rel: RelPath.optional(), force: z.boolean().optional() }), res: z.array(FileChangeSchema) },
  'changes.pending': { req: z.object({ projectId: Id }), res: z.array(FileChangeSchema) },
  'changes.mark': { req: z.object({ taskId: Id, rel: RelPath, status: z.enum(['accepted', 'rejected']) }), res: z.void() },
  'changes.contents': { req: z.object({ taskId: Id, rel: RelPath }), res: z.object({ before: z.string().nullable(), after: z.string().nullable() }) },
  'rules.list': { req: z.object({ projectId: Id }), res: z.array(z.object({ id: Id, action: z.string(), pattern: z.string(), createdAt: z.number() })) },
  'rules.delete': { req: z.object({ id: Id }), res: z.void() },

  'bench.run': { req: z.object({ model: ModelName }), res: z.object({ jobId: Id }) },
  'bench.cancel': { req: z.object({ jobId: Id }), res: z.void() },
  'bench.list': { req: none, res: z.array(BenchRecordSchema) },

  'terminal.create': { req: z.object({ projectId: Id, cols: z.number().int().min(1).max(1000), rows: z.number().int().min(1).max(500) }), res: TerminalSchema },
  'terminal.write': { req: z.object({ id: Id, data: z.string().max(65_536) }), res: z.void() },
  'terminal.resize': { req: z.object({ id: Id, cols: z.number().int().min(1).max(1000), rows: z.number().int().min(1).max(500) }), res: z.void() },
  'terminal.kill': { req: z.object({ id: Id }), res: z.void() },
  'terminal.list': { req: z.object({ projectId: Id }), res: z.array(TerminalSchema) },

  'backups.list': { req: none, res: z.array(BackupSchema) },
  'backups.create': { req: none, res: BackupSchema },
  'backups.reveal': { req: none, res: z.void() },
  /** Restaurar: valida la copia, la programa y reinicia la app (se aplica al arrancar, tras copiar el estado actual). */
  'backups.inspect': { req: z.object({ file: z.string().min(1).max(200) }), res: DbSummarySchema },
  'backups.restore': { req: z.object({ file: z.string().min(1).max(200) }), res: z.object({ restarting: z.boolean() }) },

  /** Exportar / importar todos los datos en un archivo .zhaska (los diálogos de archivo los abre main). */
  'data.exportEstimate': { req: none, res: z.object({ dbBytes: z.number(), attachmentsBytes: z.number(), attachmentFiles: z.number() }) },
  'data.export': { req: z.object({ includeAttachments: z.boolean() }), res: z.object({ file: z.string(), size: z.number(), attachments: z.number() }).nullable() },
  'data.importInspect': { req: none, res: ImportSummarySchema.nullable() },
  'data.importApply': { req: z.object({ token: Id }), res: z.object({ restarting: z.boolean() }) },
  'data.importCancel': { req: z.object({ token: Id }), res: z.void() },
  'data.lastOperation': { req: none, res: LastOperationSchema.nullable() },

  /** Instantáneas de los cambios del agente: espacio usado y limpieza según la retención. */
  'checkpoints.usage': { req: none, res: z.object({ bytes: z.number(), blobs: z.number() }) },
  'checkpoints.collect': { req: none, res: z.object({ removed: z.number(), freedBytes: z.number() }) },

  /** Actualizaciones: comprobar, descargar (con verificación sha512) e instalar son acciones del usuario. */
  'update.status': { req: none, res: UpdateStatusSchema },
  'update.check': { req: none, res: UpdateStatusSchema },
  'update.download': { req: none, res: UpdateStatusSchema },
  'update.install': { req: none, res: z.void() },
} as const

export const ChatEventSchema = z.object({
  taskId: Id,
  conversationId: Id,
  type: z.enum(['state', 'delta', 'done', 'cancelled', 'error']),
  state: z.enum(['loading', 'prompt', 'thinking', 'generating']).optional(),
  text: z.string().optional(),
  message: MessageSchema.optional(),
  metrics: ChatMetricsSchema.optional(),
  code: z.string().optional(),
  error: z.string().optional(),
})

export const events = {
  'fs.changed': z.object({ projectId: Id, dirs: z.array(z.string()), files: z.array(z.string()) }),
  'ollama.status': z.object({ status: OllamaStatusSchema, loaded: z.array(LoadedModelSchema) }),
  'ollama.installProgress': z.object({ fraction: z.number() }),
  'models.pull': PullProgressSchema,
  'chat.event': ChatEventSchema,
  'agent.event': AgentStreamSchema,
  'terminal.data': z.object({ id: Id, data: z.string() }),
  'projects.log': z.object({ jobId: Id, line: z.string() }),
  'terminal.exit': z.object({ id: Id, exitCode: z.number() }),
  'attachments.updated': AttachmentSchema.extend({ progress: z.string().optional() }),
  'bench.event': z.object({ jobId: Id, model: z.string(), type: z.enum(['progress', 'done', 'error']), step: z.string().optional(), index: z.number().optional(), total: z.number().optional(), record: BenchRecordSchema.optional(), error: z.string().optional() }),
  'update.status': UpdateStatusSchema,
} as const

export type Channel = keyof typeof contract
export type EventName = keyof typeof events
export type Req<C extends Channel> = z.input<(typeof contract)[C]['req']>
export type Res<C extends Channel> = z.output<(typeof contract)[C]['res']>
export type EventPayload<E extends EventName> = z.output<(typeof events)[E]>

export type Project = z.output<typeof ProjectSchema>
export type DirEntry = z.output<typeof DirEntrySchema>
export type FileContent = z.output<typeof FileContentSchema>
export type ConversationRow = z.output<typeof ConversationSchema>
export type MessageRow = z.output<typeof MessageSchema>
export type AppInfo = z.output<typeof AppInfoSchema>
export type Backup = z.output<typeof BackupSchema>
export type OllamaStatus = z.output<typeof OllamaStatusSchema>
export type LoadedModel = z.output<typeof LoadedModelSchema>
export type Hardware = z.output<typeof HardwareSchema>
export type InstalledModel = z.output<typeof InstalledModelSchema>
export type PullProgress = z.output<typeof PullProgressSchema>
export type ChatEvent = z.output<typeof ChatEventSchema>
export type BenchRecord = z.output<typeof BenchRecordSchema>
export type ChatMetricsRow = z.output<typeof ChatMetricsSchema>
export type FileChange = z.output<typeof FileChangeSchema>
export type AgentStream = z.output<typeof AgentStreamSchema>
export type ActivityTask = z.output<typeof ActivityTaskSchema>
export type TerminalInfo = z.output<typeof TerminalSchema>
export type AttachmentRow = z.output<typeof AttachmentSchema>
export type AttachmentPreview = z.output<typeof AttachmentPreviewSchema>
export type ImportSummary = z.output<typeof ImportSummarySchema>
export type UpdateStatus = z.output<typeof UpdateStatusSchema>
export type Metrics = z.output<typeof MetricsSchema>
export type DevTools = z.output<typeof DevToolsSchema>
export type LastOperation = z.output<typeof LastOperationSchema>

/** Resultado serializable de cada llamada: los errores llegan estructurados, nunca como excepciones opacas. */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: { code: IpcErrorCode; message: string } }
export type IpcErrorCode = 'INVALID_INPUT' | 'NOT_FOUND' | 'FORBIDDEN' | 'FORBIDDEN_PATH' | 'CONFLICT' | 'EXISTS' | 'IO' | 'INTERNAL'
