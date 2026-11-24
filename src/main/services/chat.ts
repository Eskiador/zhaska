import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { ChatEvent, ConversationRow, MessageRow } from '@shared/ipc/contract'
import type { ChatTurn, HostEvent } from '@shared/agent/host'
import { chatSystemPrompt, titleFromMessage } from '@shared/agent/prompts'
import { DEFAULT_OLLAMA_HOST } from '@shared/ollama/defaults'
import { AppError } from '@core/errors'
import type { ConversationsRepo, ProjectsRepo, SettingsRepo } from '../db/repos'
import type { AgentHostBridge } from '../agentHost'
import type { AttachmentService } from './attachments'
import { IGNORED_DIRS } from '@core/workspace/fileService'

interface Task {
  conversationId: string
  model: string
  text: string
}

const MAX_GUIDE_CHARS = 4000

/** Convierte el historial guardado en turnos para el modelo, respetando un presupuesto aproximado de contexto. */
export function toTurns(messages: MessageRow[], budgetChars: number): ChatTurn[] {
  const turns: ChatTurn[] = []
  let used = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role !== 'user' && m.role !== 'assistant') continue
    const content = (m.blocks as { kind?: string; text?: string; code?: string; lang?: string; items?: { name: string }[] }[])
      .map((b) =>
        b.kind === 'text' ? b.text : b.kind === 'code' ? `\`\`\`${b.lang ?? ''}\n${b.code}\n\`\`\`` : b.kind === 'attachments' ? `[Adjuntó: ${(b.items ?? []).map((i) => i.name).join(', ')}]` : null,
      )
      .filter(Boolean)
      .join('\n\n')
    if (!content) continue
    if (used + content.length > budgetChars && turns.length > 0) break
    used += content.length
    turns.unshift({ role: m.role, content })
  }
  return turns
}

/**
 * Chat sin herramientas (Fase 4): guarda el mensaje del usuario, construye el contexto,
 * delega la generación en el Agent Host y guarda la respuesta con sus métricas.
 */
export class ChatService {
  private tasks = new Map<string, Task>()

  constructor(
    private readonly deps: {
      conversations: ConversationsRepo
      projects: ProjectsRepo
      settings: SettingsRepo
      host: AgentHostBridge
      attachments: AttachmentService
      emit: (e: ChatEvent) => void
    },
  ) {
    deps.host.onEvent((e) => this.onHostEvent(e))
    deps.host.onExit(() => {
      for (const [taskId, t] of this.tasks) this.finish(taskId, t, 'error', { code: 'HOST_RESTARTED', error: 'El proceso del agente se reinició. Vuelve a intentarlo.' })
    })
  }

  active() {
    return [...this.tasks.entries()].map(([taskId, t]) => ({ taskId, conversationId: t.conversationId, text: t.text, model: t.model }))
  }

  async send(input: { conversationId: string; text: string; model: string; attachmentIds?: string[] }): Promise<{ taskId: string; message: MessageRow; conversation: ConversationRow }> {
    const { conversations, projects, settings } = this.deps
    if ([...this.tasks.values()].some((t) => t.conversationId === input.conversationId)) throw new AppError('CONFLICT', 'Ya hay una respuesta en curso en esta conversación')
    const conv = conversations.get(input.conversationId)
    const project = projects.get(conv.projectId)
    const ids = input.attachmentIds ?? []
    const atts = this.deps.attachments.validateForSend(ids)
    const message = conversations.addMessage(conv.id, 'user', userBlocks(input.text, atts))
    this.deps.attachments.link(message.id, ids)
    if (conv.title === 'Nueva conversación') conversations.rename(conv.id, titleFromMessage(input.text))

    const numCtx = settings.get('numCtx', 32768)
    const system = chatSystemPrompt({ projectName: project.name, ...(await projectContext(project.rootPath)) })
    // ~3 caracteres por token en español y código; se reserva un cuarto del contexto para la respuesta
    const budget = Math.max(2000, numCtx * 3 * 0.75 - system.length)
    const turns = toTurns(conversations.messages(conv.id), budget)

    const taskId = randomUUID()
    this.tasks.set(taskId, { conversationId: conv.id, model: input.model, text: '' })
    void (async () => {
      // Adjuntos: su texto va en el último turno del usuario; las imágenes, solo si el modelo tiene visión
      if (ids.length) {
        const ctx = await this.deps.attachments.forModel({ ids, conversationId: conv.id, model: input.model, visionSetting: settings.get('visionModel', 'auto'), budgetChars: numCtx * 3 * 0.45, tools: false })
        const last = turns[turns.length - 1]
        if (last?.role === 'user') {
          last.content = `${last.content}\n\n${ctx.text}`
          if (ctx.images.length) last.images = ctx.images
        }
      }
      if (!this.tasks.has(taskId)) return
      this.deps.host.send({
        type: 'chat.start',
        taskId,
        host: settings.get('ollamaHost', DEFAULT_OLLAMA_HOST),
        model: input.model,
        messages: [{ role: 'system', content: system }, ...turns],
        numCtx,
        temperature: settings.get('temperature', 0.2),
        think: settings.get('thinking', true),
      })
    })().catch((e) => this.onHostEvent({ type: 'chat.error', taskId, code: 'MODEL_ERROR', message: `No se pudieron preparar los adjuntos: ${(e as Error).message}`, text: '' }))
    return { taskId, message, conversation: conversations.get(conv.id) }
  }

  cancel(taskId: string) {
    if (this.tasks.has(taskId)) this.deps.host.send({ type: 'chat.cancel', taskId })
  }

  private onHostEvent(e: HostEvent) {
    if (!('taskId' in e)) return
    const t = this.tasks.get(e.taskId)
    if (!t) return
    const base = { taskId: e.taskId, conversationId: t.conversationId }
    switch (e.type) {
      case 'chat.state':
        this.deps.emit({ ...base, type: 'state', state: e.state })
        break
      case 'chat.delta':
        t.text += e.text
        this.deps.emit({ ...base, type: 'delta', text: e.text })
        break
      case 'chat.done':
        t.text = e.text
        this.finish(e.taskId, t, 'done', { metrics: e.metrics })
        break
      case 'chat.cancelled':
        t.text = e.text
        this.finish(e.taskId, t, 'cancelled', {})
        break
      case 'chat.error':
        t.text = e.text
        this.finish(e.taskId, t, 'error', { code: e.code, error: e.message })
        break
    }
  }

  private finish(taskId: string, t: Task, type: 'done' | 'cancelled' | 'error', extra: Partial<ChatEvent>) {
    this.tasks.delete(taskId)
    const blocks: unknown[] = []
    if (t.text.trim()) blocks.push({ kind: 'text', text: t.text })
    if (type === 'cancelled') blocks.push({ kind: 'notice', text: 'Respuesta detenida por el usuario.' })
    if (type === 'error') blocks.push({ kind: 'error', code: extra.code ?? 'MODEL_ERROR', message: extra.error ?? 'Error desconocido' })
    let message: MessageRow | undefined
    try {
      if (blocks.length) message = this.deps.conversations.addMessage(t.conversationId, 'assistant', blocks, t.model, extra.metrics ?? null)
    } catch (err) {
      console.error('[chat] no se pudo guardar la respuesta', err)
    }
    this.deps.emit({ taskId, conversationId: t.conversationId, type, message, ...extra })
  }
}

/** Bloques del mensaje del usuario: texto y, si hay, la lista de adjuntos (para mostrarlos en el historial). */
export function userBlocks(text: string, atts: { id: string; name: string; ext: string; kind: string; size: number }[]): unknown[] {
  const blocks: unknown[] = [{ kind: 'text', text }]
  if (atts.length) blocks.push({ kind: 'attachments', items: atts.map((a) => ({ id: a.id, name: a.name, ext: a.ext, kind: a.kind, size: a.size })) })
  return blocks
}

/** Contexto ligero del proyecto: elementos de la raíz y ZHASKA.md. El contexto completo llega con el agente (Fase 5). */
async function projectContext(root: string): Promise<{ tree: string[]; guide: string | null }> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const tree = entries
    .filter((d) => !IGNORED_DIRS.has(d.name) && !d.name.startsWith('.'))
    .slice(0, 60)
    .map((d) => (d.isDirectory() ? `${d.name}/` : d.name))
  const guide = await readFile(path.join(root, 'ZHASKA.md'), 'utf8').then(
    (s) => (s.length > MAX_GUIDE_CHARS ? `${s.slice(0, MAX_GUIDE_CHARS)}\n…` : s),
    () => null,
  )
  return { tree, guide }
}
