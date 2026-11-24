import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { AgentStream, ConversationRow, FileChange, MessageRow } from '@shared/ipc/contract'
import type { AgentStartRequest, HostEvent } from '@shared/agent/host'
import type { ToolName } from '@shared/agent/events'
import { titleFromMessage } from '@shared/agent/prompts'
import { DEFAULT_OLLAMA_HOST } from '@shared/ollama/defaults'
import { DEFAULT_PROTECTED_PATTERNS } from '@shared/protectedFiles'
import { AppError } from '@core/errors'
import { PathGuard } from '@core/security/pathGuard'
import { defaultShell } from '@core/commands/runner'
import { createHash } from 'node:crypto'
import type { AgentRepo, ConversationsRepo, FileChangeRecord, ProjectsRepo, SettingsRepo } from '../db/repos'
import type { AgentHostBridge } from '../agentHost'
import { toTurns, userBlocks } from './chat'
import type { AttachmentService } from './attachments'

const VERB: Record<string, string> = {
  get_project_structure: 'Explorado',
  list_files: 'Listado',
  read_file: 'Leído',
  read_attachment: 'Adjunto leído',
  search_code: 'Buscado',
  read_project_config: 'Configuración',
  update_plan: 'Plan',
  create_file: 'Creado',
  edit_file: 'Editado',
  write_file: 'Reescrito',
  delete_file: 'Eliminado',
  execute_command: 'Ejecutado',
  install_dependencies: 'Instalado',
  run_tests: 'Pruebas',
  inspect_errors: 'Comprobado',
}

const DEFAULT_PERMISSIONS = { read: 'allow', write: 'ask', execute: 'ask', install: 'ask', internet: 'block' } as const

const MAX_OUTPUT_LINES_PER_STEP = 400

interface Task {
  outputLines: Map<string, number>
  conversationId: string
  projectId: string
  root: string
  model: string
  text: string
}

const toFileChange = (c: FileChangeRecord): FileChange => ({ taskId: c.taskId, rel: c.rel, kind: c.kind, additions: c.additions, deletions: c.deletions, status: c.status })

/**
 * Coordina el agente (Fase 5): arranca tareas en el Agent Host, reenvía sus eventos reales a la UI,
 * guarda cambios y reglas en SQLite y aplica "aceptar / rechazar" con verificación por hash.
 */
export class AgentService {
  private tasks = new Map<string, Task>()

  constructor(
    private readonly deps: {
      conversations: ConversationsRepo
      projects: ProjectsRepo
      settings: SettingsRepo
      agent: AgentRepo
      host: AgentHostBridge
      checkpointsDir: string
      emit: (e: AgentStream) => void
      busy: (conversationId: string) => boolean
      trash: (abs: string) => Promise<void>
      attachments: AttachmentService
      externalDirs?: (projectId: string) => string[]
      blockedDirs?: string[]
    },
  ) {
    deps.agent.closeOrphans()
    deps.host.onEvent((e) => this.onHostEvent(e))
    deps.host.onExit(() => {
      for (const [taskId] of this.tasks) this.onHostEvent({ type: 'agent.done', taskId, result: { status: 'failed', text: '', error: 'El proceso del agente se reinició.', steps: [], metrics: { promptTokens: 0, evalTokens: 0, steps: 0, lastTokensPerSec: 0 } } })
    })
  }

  isBusy(conversationId: string) {
    return [...this.tasks.values()].some((t) => t.conversationId === conversationId)
  }

  active() {
    return [...this.tasks.entries()].map(([taskId, t]) => ({ taskId, conversationId: t.conversationId, text: t.text, model: t.model }))
  }

  async start(input: { conversationId: string; text: string; model: string; attachmentIds?: string[] }): Promise<{ taskId: string; message: MessageRow; conversation: ConversationRow }> {
    const { conversations, projects, settings, agent } = this.deps
    if (this.isBusy(input.conversationId) || this.deps.busy(input.conversationId)) throw new AppError('CONFLICT', 'Ya hay una tarea en curso en esta conversación')
    const conv = conversations.get(input.conversationId)
    const project = projects.get(conv.projectId)
    if (!existsSync(project.rootPath)) throw new AppError('NOT_FOUND', `La carpeta del proyecto ya no existe: ${project.rootPath}`)
    const ids = input.attachmentIds ?? []
    const atts = this.deps.attachments.validateForSend(ids)
    const history = toTurns(conversations.messages(conv.id), settings.get('numCtx', 32768) * 3 * 0.3)
    const message = conversations.addMessage(conv.id, 'user', userBlocks(input.text, atts))
    this.deps.attachments.link(message.id, ids)
    if (conv.title === 'Nueva conversación') conversations.rename(conv.id, titleFromMessage(input.text))

    const taskId = randomUUID()
    agent.startTask(taskId, conv.id, project.id, input.model)
    this.tasks.set(taskId, { conversationId: conv.id, projectId: project.id, root: project.rootPath, model: input.model, text: '', outputLines: new Map() })
    const permissions = { ...DEFAULT_PERMISSIONS, ...settings.get<Record<string, string>>('permissions', {}) } as AgentStartRequest['spec']['permissions']
    const req: AgentStartRequest = {
      type: 'agent.start',
      host: settings.get('ollamaHost', DEFAULT_OLLAMA_HOST),
      spec: {
        taskId,
        model: input.model,
        root: project.rootPath,
        projectName: project.name,
        userMessage: input.text,
        history,
        numCtx: settings.get('numCtx', 32768),
        temperature: settings.get('temperature', 0.2),
        think: settings.get('thinking', true),
        maxSteps: settings.get('agentMaxSteps', 30),
        protocol: settings.get('agentProtocol', 'auto'),
        autonomy: settings.get('autonomy', 'balanced'),
        permissions,
        rules: agent.rules(project.id).map((r) => ({ action: r.action as never, pattern: r.pattern })),
        protectedPatterns: settings.get('protectedPatterns', DEFAULT_PROTECTED_PATTERNS),
        autoVerify: settings.get('autoVerify', true),
        shell: defaultShell(settings.get('shell', 'powershell')),
        blobDir: this.blobDir(project.id),
        externalDirs: this.deps.externalDirs?.(project.id) ?? [],
        blockedDirs: this.deps.blockedDirs ?? [],
      },
    }
    void (async () => {
      // Adjuntos (Fase 8): contexto de este mensaje, imágenes si el modelo tiene visión y la lista legible con read_attachment
      const ctx = await this.deps.attachments.forModel({ ids, conversationId: conv.id, model: input.model, visionSetting: settings.get('visionModel', 'auto'), budgetChars: req.spec.numCtx * 3 * 0.35, tools: true })
      req.spec.attachments = ctx.refs
      if (ctx.text) req.spec.attachmentContext = ctx.text
      if (atts.length) req.spec.attachmentNames = atts.map((x) => x.name)
      if (ctx.images.length) req.spec.images = ctx.images
      if (this.tasks.has(taskId)) this.deps.host.send(req)
    })().catch((e) =>
      this.onHostEvent({ type: 'agent.done', taskId, result: { status: 'failed', text: '', error: `No se pudieron preparar los adjuntos: ${(e as Error).message}`, steps: [], metrics: { promptTokens: 0, evalTokens: 0, steps: 0, lastTokensPerSec: 0 } } }),
    )
    return { taskId, message, conversation: conversations.get(conv.id) }
  }

  cancel(taskId: string) {
    if (this.tasks.has(taskId)) this.deps.host.send({ type: 'agent.cancel', taskId })
  }

  pause(taskId: string) {
    if (this.tasks.has(taskId)) this.deps.host.send({ type: 'agent.pause', taskId })
  }

  resume(taskId: string) {
    if (this.tasks.has(taskId)) this.deps.host.send({ type: 'agent.resume', taskId })
  }

  /** Tarea guardada con todos sus eventos, para reconstruir el panel de actividad. */
  activity(taskId: string | null) {
    if (!taskId) return null
    const t = this.deps.agent.task(taskId)
    if (!t) return null
    return { taskId: t.id, conversationId: t.conversationId, model: t.model, status: t.status as 'running' | 'completed' | 'failed' | 'cancelled', startedAt: t.startedAt, finishedAt: t.finishedAt, events: this.deps.agent.events(taskId) }
  }

  latestActivity(conversationId: string) {
    return this.activity(this.deps.agent.latestTask(conversationId))
  }

  approve(taskId: string, requestId: string, decision: 'allow_once' | 'allow_always' | 'deny') {
    if (!this.tasks.has(taskId)) throw new AppError('NOT_FOUND', 'La tarea ya no está en curso')
    this.deps.host.send({ type: 'agent.approval', taskId, requestId, decision })
  }

  private blobDir(projectId: string) {
    return path.join(this.deps.checkpointsDir, projectId, 'blobs')
  }

  private onHostEvent(e: HostEvent) {
    if (!('taskId' in e) || !e.type.startsWith('agent.')) return
    const t = this.tasks.get(e.taskId)
    if (!t) return
    const base = { taskId: e.taskId, conversationId: t.conversationId }
    switch (e.type) {
      case 'agent.event': {
        // Persistir cada evento real (la salida de comandos, acotada por paso)
        const ev = e.event as { type: string; ts: number; stepId?: string }
        if (ev.type === 'step.output' && ev.stepId) {
          const n = (t.outputLines.get(ev.stepId) ?? 0) + 1
          t.outputLines.set(ev.stepId, n)
          if (n === MAX_OUTPUT_LINES_PER_STEP + 1) this.deps.agent.addEvent(e.taskId, { ...ev, chunk: '… (salida recortada en el registro)' } as never)
          else if (n <= MAX_OUTPUT_LINES_PER_STEP) this.deps.agent.addEvent(e.taskId, ev)
        } else this.deps.agent.addEvent(e.taskId, ev)
        this.deps.emit({ ...base, kind: 'event', event: e.event })
        break
      }
      case 'agent.text':
        t.text += e.text
        this.deps.emit({ ...base, kind: 'text', text: e.text })
        break
      case 'agent.change': {
        this.deps.agent.upsertChange({ taskId: e.taskId, projectId: t.projectId, ...e.change })
        const row = this.deps.agent.changes(e.taskId).find((c) => c.rel === e.change.rel)
        if (row) this.deps.emit({ ...base, kind: 'change', change: toFileChange(row) })
        break
      }
      case 'agent.rule':
        this.deps.agent.addRule(t.projectId, e.rule.action, e.rule.pattern)
        break
      case 'agent.done': {
        this.tasks.delete(e.taskId)
        const r = e.result
        this.deps.agent.finishTask(e.taskId, r.status, r.steps.length, r.error ?? null)
        const changes = this.deps.agent.changes(e.taskId)
        const blocks: unknown[] = []
        const chips = r.steps.filter((s) => s.tool !== 'update_plan').map((s) => ({ stepId: s.stepId, tool: s.tool as ToolName, verb: VERB[s.tool] ?? s.tool, target: shortTarget(s.target ?? s.title), ok: s.ok }))
        if (chips.length) blocks.push({ kind: 'tools', chips, taskId: e.taskId })
        if (r.text.trim()) blocks.push({ kind: 'text', text: r.text.trim() })
        if (changes.length) blocks.push({ kind: 'changes', taskId: e.taskId, changes: changes.map((c) => ({ path: c.rel, kind: c.kind, additions: c.additions, deletions: c.deletions })) })
        if (r.status === 'cancelled') blocks.push({ kind: 'notice', text: 'Tarea detenida por el usuario.' })
        if (r.status === 'failed' && r.error && !r.text.includes(r.error)) blocks.push({ kind: 'error', code: 'AGENT_FAILED', message: r.error })
        if (!blocks.length) blocks.push({ kind: 'notice', text: 'El agente terminó sin respuesta.' })
        let message: MessageRow | undefined
        try {
          message = this.deps.conversations.addMessage(t.conversationId, 'assistant', blocks, t.model, {
            promptTokens: r.metrics.promptTokens,
            evalTokens: r.metrics.evalTokens,
            loadMs: 0,
            promptMs: 0,
            evalMs: 0,
            totalMs: 0,
            tokensPerSec: r.metrics.lastTokensPerSec,
            prefillTokensPerSec: 0,
          })
        } catch (err) {
          console.error('[agent] no se pudo guardar la respuesta', err)
        }
        this.deps.emit({ ...base, kind: 'done', message })
        break
      }
    }
  }

  /* ───────── Cambios: aceptar, rechazar (restaurar) y contenido para el diff ───────── */

  private task(taskId: string) {
    const changes = this.deps.agent.changes(taskId)
    if (!changes.length) throw new AppError('NOT_FOUND', 'Esta tarea no tiene cambios')
    const project = this.deps.projects.get(changes[0]!.projectId)
    return { changes, guard: new PathGuard(project.rootPath), blobs: this.blobDir(project.id) }
  }

  pending(projectId: string): FileChange[] {
    return this.deps.agent.pendingForProject(projectId).map(toFileChange)
  }

  /** Marca un archivo como revisado sin tocar el disco (tras aceptar o rechazar cambio a cambio en el editor). */
  mark(taskId: string, rel: string, status: 'accepted' | 'rejected') {
    this.deps.agent.setChangeStatus(taskId, rel, status)
  }

  listChanges(taskId: string): FileChange[] {
    return this.deps.agent.changes(taskId).map(toFileChange)
  }

  accept(taskId: string, rel?: string): FileChange[] {
    for (const c of this.deps.agent.changes(taskId)) if ((!rel || c.rel === rel) && c.status === 'pending') this.deps.agent.setChangeStatus(taskId, c.rel, 'accepted')
    return this.listChanges(taskId)
  }

  /** Restaura el estado anterior. Si el archivo cambió después de la tarea, avisa (CONFLICT) salvo `force`. */
  async reject(taskId: string, rel?: string, force = false): Promise<FileChange[]> {
    const { changes, guard, blobs } = this.task(taskId)
    const targets = changes.filter((c) => (!rel || c.rel === rel) && c.status !== 'rejected')
    for (const c of targets) {
      const abs = guard.resolve(c.rel)
      const current = existsSync(abs) ? await readFile(abs) : null
      const currentHash = current ? createHash('sha256').update(current).digest('hex') : null
      if (!force && currentHash !== c.afterHash) throw new AppError('CONFLICT', `${c.rel} ha cambiado después de la tarea. Si lo restauras perderás esos cambios.`)
    }
    for (const c of targets) {
      const abs = guard.resolve(c.rel)
      if (c.beforeHash === null) {
        if (existsSync(abs)) await this.deps.trash(abs)
      } else {
        const original = await readFile(path.join(blobs, c.beforeHash))
        await mkdir(path.dirname(abs), { recursive: true })
        await writeFile(abs, original)
      }
      this.deps.agent.setChangeStatus(taskId, c.rel, 'rejected')
    }
    return this.listChanges(taskId)
  }

  async contents(taskId: string, rel: string): Promise<{ before: string | null; after: string | null }> {
    const { changes, blobs } = this.task(taskId)
    const c = changes.find((x) => x.rel === rel)
    if (!c) throw new AppError('NOT_FOUND', `Sin cambios en ${rel}`)
    const read = (h: string | null) =>
      h
        ? readFile(path.join(blobs, h), 'utf8').catch((e: NodeJS.ErrnoException) => {
            if (e.code === 'ENOENT') throw new AppError('NOT_FOUND', 'Las instantáneas de este cambio ya no están: se eliminaron al cumplirse el plazo de conservación (Ajustes → Privacidad).')
            throw e
          })
        : Promise.resolve(null)
    return { before: await read(c.beforeHash), after: await read(c.afterHash) }
  }
}

function shortTarget(t: string) {
  const s = t.length > 60 ? `${t.slice(0, 57)}…` : t
  return s.includes('/') && !s.includes(' ') ? s.split('/').pop()! : s
}
