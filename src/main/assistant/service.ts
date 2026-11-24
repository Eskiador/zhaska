import { randomUUID } from 'node:crypto'
import type { AssistantConversation, AssistantEvent, AssistantMessage, ChatMetricsRow, MessageRow } from '@shared/ipc/contract'
import type { HostEvent } from '@shared/agent/host'
import { assistantSystemPrompt, citedNumbers, NOT_FOUND_PHRASE, sourcesBlock, type AssistantSource } from '@shared/assistant'
import { titleFromMessage } from '@shared/agent/prompts'
import { DEFAULT_OLLAMA_HOST } from '@shared/ollama/defaults'
import { AppError } from '@core/errors'
import type { SettingsRepo } from '../db/repos'
import type { AgentHostBridge } from '../agentHost'
import type { AttachmentService } from '../services/attachments'
import { toTurns, userBlocks } from '../services/chat'
import type { AssistantRepo } from './repos'
import type { KnowledgeService } from './knowledge'

interface Task {
  conversationId: string
  model: string
  text: string
  sources: AssistantSource[]
}

/** Fragmento guardado con cada fuente en el historial (las conversaciones privadas no guardan nada). */
const STORED_EXCERPT = 700

/**
 * Chat del asistente de empresa (Fase 12). Separado del de programación: sin proyecto y SIN herramientas
 * (no puede leer, escribir ni ejecutar nada por su cuenta). Lo único que ve el modelo es la pregunta, lo que
 * adjunte el usuario y los fragmentos que encuentra la búsqueda local en las bases de conocimiento elegidas.
 *
 * Conversaciones privadas: viven solo en memoria y desaparecen al cerrar la app. Son obligatorias con
 * cualquier base marcada como confidencial.
 */
export class AssistantService {
  private tasks = new Map<string, Task>()
  private privates = new Map<string, { conv: AssistantConversation; messages: AssistantMessage[] }>()

  constructor(
    private readonly deps: {
      repo: AssistantRepo
      knowledge: KnowledgeService
      settings: SettingsRepo
      host: AgentHostBridge
      attachments: AttachmentService
      emit: (e: AssistantEvent) => void
      now?: () => Date
    },
  ) {
    deps.host.onEvent((e) => this.onHostEvent(e))
    deps.host.onExit(() => {
      for (const [taskId, t] of this.tasks) this.finish(taskId, t, 'error', { code: 'HOST_RESTARTED', error: 'El proceso del modelo se reinició. Vuelve a intentarlo.' })
    })
  }

  list(): AssistantConversation[] {
    return [...[...this.privates.values()].map((p) => p.conv), ...this.deps.repo.list()].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  get(id: string): AssistantConversation {
    return this.privates.get(id)?.conv ?? this.deps.repo.get(id)
  }

  private confidentialIn(ids: string[]) {
    const all = this.deps.knowledge.list()
    return all.filter((c) => ids.includes(c.id) && c.confidential)
  }

  private validCollections(ids: string[]) {
    const known = new Set(this.deps.knowledge.list().map((c) => c.id))
    return [...new Set(ids)].filter((id) => known.has(id))
  }

  create(input: { collectionIds: string[]; private: boolean }): AssistantConversation {
    const collectionIds = this.validCollections(input.collectionIds)
    const mustBePrivate = this.confidentialIn(collectionIds).length > 0
    if (input.private || mustBePrivate) {
      const now = Date.now()
      const conv: AssistantConversation = { id: `privada-${randomUUID()}`, title: 'Conversación privada', collectionIds, createdAt: now, updatedAt: now, messageCount: 0, private: true }
      this.privates.set(conv.id, { conv, messages: [] })
      return conv
    }
    return this.deps.repo.create(collectionIds)
  }

  update(id: string, patch: { title?: string; collectionIds?: string[] }): AssistantConversation {
    const collectionIds = patch.collectionIds ? this.validCollections(patch.collectionIds) : undefined
    const p = this.privates.get(id)
    if (p) {
      p.conv = { ...p.conv, ...(patch.title ? { title: patch.title.trim() } : {}), ...(collectionIds ? { collectionIds } : {}) }
      return p.conv
    }
    if (collectionIds) {
      const conf = this.confidentialIn(collectionIds)
      if (conf.length) throw new AppError('FORBIDDEN', `«${conf[0]!.name}» es confidencial: úsala en una conversación privada (no se guarda nada en disco).`)
    }
    return this.deps.repo.update(id, { title: patch.title, collectionIds })
  }

  delete(id: string) {
    if (this.privates.delete(id)) return
    this.deps.repo.delete(id)
  }

  messages(id: string): AssistantMessage[] {
    return this.privates.get(id)?.messages ?? this.deps.repo.messages(id)
  }

  active() {
    return [...this.tasks.entries()].map(([taskId, t]) => ({ taskId, conversationId: t.conversationId, text: t.text, model: t.model }))
  }

  private addMessage(conversationId: string, role: 'user' | 'assistant', blocks: unknown[], model: string | null = null, metrics: ChatMetricsRow | null = null): AssistantMessage {
    const p = this.privates.get(conversationId)
    if (!p) return this.deps.repo.addMessage(conversationId, role, blocks, model, metrics)
    const m: AssistantMessage = { id: randomUUID(), conversationId, role, blocks, model, metrics, createdAt: Date.now() }
    p.messages.push(m)
    p.conv = { ...p.conv, updatedAt: m.createdAt, messageCount: p.messages.length }
    return m
  }

  async send(input: { conversationId: string; text: string; model: string; attachmentIds?: string[] }): Promise<{ taskId: string; message: AssistantMessage; conversation: AssistantConversation }> {
    const { settings } = this.deps
    if ([...this.tasks.values()].some((t) => t.conversationId === input.conversationId)) throw new AppError('CONFLICT', 'Ya hay una respuesta en curso en esta conversación')
    const conv = this.get(input.conversationId)
    // Una base que pasó a confidencial después de crear la conversación: no se usa en una conversación guardada
    if (!conv.private && this.confidentialIn(conv.collectionIds).length) throw new AppError('FORBIDDEN', 'Una de las bases de esta conversación es confidencial: abre una conversación privada para usarla.')
    const ids = input.attachmentIds ?? []
    const atts = this.deps.attachments.validateForSend(ids)
    const history = this.messages(conv.id)
    const message = this.addMessage(conv.id, 'user', userBlocks(input.text, atts))
    if (conv.title === 'Nueva conversación' || (conv.private && history.length === 0)) {
      const title = titleFromMessage(input.text)
      if (conv.private) this.privates.get(conv.id)!.conv.title = title
      else this.deps.repo.update(conv.id, { title })
    }

    const taskId = randomUUID()
    const task: Task = { conversationId: conv.id, model: input.model, text: '', sources: [] }
    this.tasks.set(taskId, task)
    void (async () => {
      this.deps.emit({ taskId, conversationId: conv.id, type: 'state', state: 'searching' })
      const numCtx = settings.get('numCtx', 32768)
      const collections = this.deps.knowledge.list().filter((c) => conv.collectionIds.includes(c.id))
      task.sources = collections.length ? await this.deps.knowledge.search(conv.collectionIds, input.text) : []
      if (!this.tasks.has(taskId)) return
      if (collections.length) this.deps.emit({ taskId, conversationId: conv.id, type: 'sources', sources: task.sources })
      const date = (this.deps.now?.() ?? new Date()).toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
      const system = assistantSystemPrompt({ collections: collections.map((c) => c.name), date })
      const sourcesText = collections.length ? sourcesBlock(task.sources) : ''
      const budget = Math.max(2000, numCtx * 3 * 0.75 - system.length - sourcesText.length)
      const turns = toTurns(this.messages(conv.id) as unknown as MessageRow[], budget)
      const last = turns[turns.length - 1]
      if (last?.role === 'user') {
        if (ids.length) {
          const ctx = await this.deps.attachments.forModel({ ids, conversationId: conv.id, model: input.model, visionSetting: settings.get('visionModel', 'auto'), budgetChars: numCtx * 3 * 0.35, tools: false })
          last.content = `${last.content}\n\n${ctx.text}`
          if (ctx.images.length) last.images = ctx.images
        }
        if (sourcesText) last.content = `${last.content}\n\n${sourcesText}`
      }
      if (!this.tasks.has(taskId)) return
      this.deps.host.send({
        type: 'chat.start',
        taskId,
        host: settings.get('ollamaHost', DEFAULT_OLLAMA_HOST),
        model: input.model,
        messages: [{ role: 'system', content: system }, ...turns],
        numCtx,
        // Respuestas sobre documentos: lo más fiel posible al texto
        temperature: Math.min(settings.get('temperature', 0.2), 0.3),
        think: settings.get('thinking', true),
      })
    })().catch((e) => this.onHostEvent({ type: 'chat.error', taskId, code: 'MODEL_ERROR', message: `No se pudo preparar la respuesta: ${(e as Error).message}`, text: '' }))
    return { taskId, message, conversation: this.get(conv.id) }
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

  private finish(taskId: string, t: Task, type: 'done' | 'cancelled' | 'error', extra: Partial<AssistantEvent>) {
    this.tasks.delete(taskId)
    const blocks: unknown[] = []
    if (t.text.trim()) blocks.push({ kind: 'text', text: t.text })
    if (t.sources.length) {
      const cited = new Set(citedNumbers(t.text))
      blocks.push({ kind: 'sources', items: t.sources.map((s) => ({ ...s, text: s.text.slice(0, STORED_EXCERPT), cited: cited.has(s.n) })) })
    }
    const check = type === 'done' ? checkAnswer(t.text, t.sources) : null
    if (check) blocks.push({ kind: 'notice', text: check })
    if (type === 'cancelled') blocks.push({ kind: 'notice', text: 'Respuesta detenida por el usuario.' })
    if (type === 'error') blocks.push({ kind: 'error', code: extra.code ?? 'MODEL_ERROR', message: extra.error ?? 'Error desconocido' })
    let message: AssistantMessage | undefined
    try {
      if (blocks.length) message = this.addMessage(t.conversationId, 'assistant', blocks, t.model, extra.metrics ?? null)
    } catch (err) {
      console.error('[asistente] no se pudo guardar la respuesta', err)
    }
    this.deps.emit({ taskId, conversationId: t.conversationId, type, message, ...extra })
  }
}

/**
 * Comprobación de la respuesta frente a sus fuentes: avisa si cita números que no existen o si da datos
 * sin citar nada habiendo fuentes. No sustituye a la revisión del usuario, pero hace visibles los fallos típicos.
 */
export function checkAnswer(text: string, sources: AssistantSource[]): string | null {
  if (!sources.length) return null
  const cited = citedNumbers(text)
  const missing = cited.filter((n) => !sources.some((s) => s.n === n))
  if (missing.length) return `Atención: la respuesta cita ${missing.map((n) => `[${n}]`).join(', ')}, que no corresponde a ningún fragmento encontrado. Compruébala en los documentos.`
  if (!cited.length && !text.includes(NOT_FOUND_PHRASE) && /\d/.test(text)) return 'La respuesta da datos sin citar ninguna fuente: compruébalos en los documentos antes de usarlos.'
  return null
}
