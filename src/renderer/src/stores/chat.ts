import { create } from 'zustand'
import type { AgentStream, ChatEvent, ChatMetricsRow, FileChange, MessageRow } from '@shared/ipc/contract'
import type { AgentEvent } from '@shared/agent/events'
import { useActivity } from './activity'
import { useLayout } from './layout'
import { useSettings } from './settings'
import type { ModelPhase } from '@shared/agent/host'
import { DEMO_CONVERSATIONS, type AttachmentMeta, type ChatBlock, type ChatMessage } from '@renderer/demo/conversations'
import { api, errorMessage, hasBackend, onEvent } from '@renderer/lib/api'
import { toast } from './ui'
import { toMeta, useAttachments } from './attachments'
import { ATTACHMENT_LIMITS, extOf as extOfName, kindOfExt, type AttachmentKind } from '@shared/attachments'

export interface ConversationItem {
  id: string
  projectId: string
  title: string
  updatedAt: number
  messageCount: number
}

/** Respuesta en curso de una conversación (streaming). */
export interface LiveReply {
  kind: 'chat' | 'agent'
  taskId: string
  model: string
  text: string
  state: ModelPhase | 'approval' | 'paused'
  startedAt: number
  changes: Record<string, FileChange>
}

interface ChatStore {
  demo: boolean
  live: Record<string, LiveReply>
  lastMetrics: (ChatMetricsRow & { model: string }) | null
  conversations: ConversationItem[]
  messages: Record<string, ChatMessage[]>
  activeId: string | null
  draft: string
  /** Adjuntos del composer: se guardan y procesan en local nada más añadirlos; se envían con el mensaje. */
  attachments: AttachmentMeta[]
  insertRequest: { text: string; n: number } | null
  loadDemo: () => void
  loadForProject: (projectId: string) => Promise<void>
  clear: () => void
  select: (id: string) => Promise<void>
  newConversation: (projectId: string) => Promise<void>
  rename: (id: string, title: string) => Promise<void>
  remove: (id: string) => Promise<void>
  setDraft: (v: string) => void
  addFiles: (files: File[]) => void
  removeAttachment: (id: string) => void
  /** Pide al composer que inserte texto en el cursor (p. ej. una mención desde el explorador). */
  requestInsert: (text: string) => void
  send: (projectId: string, text: string, model: string) => Promise<boolean>
  cancel: (conversationId: string) => Promise<void>
  initStreaming: () => Promise<void>
}

let seq = 0

const toChatMessage = (m: MessageRow): ChatMessage => {
  const att = (m.blocks as { kind?: string; items?: { id: string; name: string; ext: string; kind: AttachmentKind; size: number }[] }[]).find((b) => b.kind === 'attachments')
  return {
    id: m.id,
    role: m.role === 'user' ? 'user' : 'assistant',
    ts: m.createdAt,
    model: m.model ?? undefined,
    blocks: m.blocks as ChatBlock[],
    metrics: m.metrics,
    attachments: att?.items?.map((i) => ({ ...i, status: 'ready' as const, stored: true })),
  }
}

const report = (title: string) => (e: unknown) => toast({ tone: 'error', title, description: errorMessage(e) })

export const useChat = create<ChatStore>((set, get) => ({
  demo: false,
  live: {},
  lastMetrics: null,
  conversations: [],
  messages: {},
  activeId: null,
  draft: '',
  attachments: [],
  insertRequest: null,

  loadDemo: () =>
    set({
      demo: true,
      conversations: DEMO_CONVERSATIONS.map((c) => ({ id: c.id, projectId: c.projectId, title: c.title, updatedAt: c.updatedAt, messageCount: c.messages.length })),
      messages: Object.fromEntries(DEMO_CONVERSATIONS.map((c) => [c.id, c.messages])),
      activeId: 'c1',
    }),

  loadForProject: async (projectId) => {
    set({ demo: false, conversations: [], messages: {}, activeId: null })
    try {
      const list = await api('conversations.list', { projectId })
      set({ conversations: list })
      if (list[0]) await get().select(list[0].id)
    } catch (e) {
      report('No se pudieron cargar las conversaciones')(e)
    }
  },

  clear: () => {
    get().attachments.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl))
    set({ demo: false, conversations: [], messages: {}, activeId: null, draft: '', attachments: [] })
  },

  select: async (id) => {
    set({ activeId: id })
    if (!get().demo) void useActivity.getState().loadLatest(id)
    if (get().demo || get().messages[id]) return
    try {
      void useAttachments.getState().loadConversation(id)
      const rows = await api('messages.list', { conversationId: id })
      set({ messages: { ...get().messages, [id]: rows.map(toChatMessage) } })
    } catch (e) {
      report('No se pudo abrir la conversación')(e)
    }
  },

  newConversation: async (projectId) => {
    // Reutilizar una conversación nueva vacía en lugar de acumular vacías
    const emptyOne = get().conversations.find((c) => c.messageCount === 0 && c.title === 'Nueva conversación')
    if (emptyOne) return get().select(emptyOne.id)
    if (get().demo) {
      const id = `demo-new-${++seq}`
      set({ conversations: [{ id, projectId, title: 'Nueva conversación', updatedAt: Date.now(), messageCount: 0 }, ...get().conversations], messages: { ...get().messages, [id]: [] }, activeId: id })
      return
    }
    try {
      const c = await api('conversations.create', { projectId })
      set({ conversations: [c, ...get().conversations], messages: { ...get().messages, [c.id]: [] }, activeId: c.id })
    } catch (e) {
      report('No se pudo crear la conversación')(e)
    }
  },

  rename: async (id, title) => {
    const clean = title.trim()
    if (!clean) return
    const apply = () => set({ conversations: get().conversations.map((c) => (c.id === id ? { ...c, title: clean } : c)) })
    if (get().demo) return apply()
    try {
      await api('conversations.rename', { id, title: clean })
      apply()
    } catch (e) {
      report('No se pudo renombrar')(e)
    }
  },

  remove: async (id) => {
    const apply = () => {
      const rest = get().conversations.filter((c) => c.id !== id)
      set({ conversations: rest, activeId: get().activeId === id ? (rest[0]?.id ?? null) : get().activeId })
      const next = get().activeId
      if (next) void get().select(next)
    }
    if (get().demo) return apply()
    try {
      await api('conversations.delete', { id })
      apply()
    } catch (e) {
      report('No se pudo eliminar la conversación')(e)
    }
  },

  setDraft: (draft) => set({ draft }),
  addFiles: (files) => {
    const current = get().attachments
    const room = ATTACHMENT_LIMITS.perMessage - current.length
    if (files.length > room) toast({ tone: 'error', title: `Máximo ${ATTACHMENT_LIMITS.perMessage} adjuntos por mensaje` })
    for (const f of files.slice(0, Math.max(0, room))) {
      const ext = extOfName(f.name)
      const kind = kindOfExt(ext)
      const tooBig = f.size > ATTACHMENT_LIMITS.fileBytes
      const local: AttachmentMeta = {
        id: `local-${++seq}`,
        name: f.name,
        ext,
        size: f.size,
        kind,
        status: tooBig || !hasBackend ? 'error' : 'queued',
        error: tooBig ? 'Supera el límite de 50 MB' : !hasBackend ? 'Los adjuntos se procesan en la aplicación de escritorio.' : undefined,
        previewUrl: kind === 'image' && !tooBig ? URL.createObjectURL(f) : undefined,
      }
      set({ attachments: [...get().attachments, local] })
      if (tooBig || !hasBackend) continue
      // Se guarda y procesa en local al momento (el contenido viaja por IPC; nunca rutas)
      void f
        .arrayBuffer()
        .then((buf) => api('attachments.upload', { name: f.name, data: new Uint8Array(buf) }))
        .then((row) => {
          useAttachments.getState().upsert([row])
          const still = get().attachments.some((a) => a.id === local.id)
          if (!still) return void api('attachments.remove', { id: row.id }).catch(() => {})
          if (local.previewUrl) URL.revokeObjectURL(local.previewUrl)
          set({ attachments: get().attachments.map((a) => (a.id === local.id ? toMeta(row) : a)) })
        })
        .catch((e) => set({ attachments: get().attachments.map((a) => (a.id === local.id ? { ...a, status: 'error', error: errorMessage(e) } : a)) }))
    }
  },
  removeAttachment: (id) => {
    const a = get().attachments.find((x) => x.id === id)
    if (a?.previewUrl) URL.revokeObjectURL(a.previewUrl)
    if (a?.stored) void api('attachments.remove', { id }).catch(() => {})
    set({ attachments: get().attachments.filter((x) => x.id !== id) })
  },
  requestInsert: (text) => set({ insertRequest: { text, n: (get().insertRequest?.n ?? 0) + 1 } }),

  send: async (projectId, text, model) => {
    if (get().demo) {
      toast({ tone: 'info', title: 'Proyecto de demostración', description: 'Abre o crea un proyecto real para conversar con el modelo.' })
      return false
    }
    const atts = get().attachments
    if (atts.some((a) => a.status === 'queued' || a.status === 'processing')) {
      toast({ tone: 'info', title: 'Procesando adjuntos', description: 'Espera a que todos estén listos para enviar el mensaje.' })
      return false
    }
    if (atts.some((a) => a.status === 'error')) {
      toast({ tone: 'error', title: 'Hay adjuntos con error', description: 'Quítalos para enviar el mensaje.' })
      return false
    }
    const attachmentIds = atts.map((a) => a.id)
    let convId = get().activeId
    if (!convId) {
      await get().newConversation(projectId)
      convId = get().activeId
      if (!convId) return false
    }
    if (get().live[convId]) return false
    const kind = useSettings.getState().composerMode
    try {
      const r = kind === 'agent' ? await api('agent.start', { conversationId: convId, text, model, attachmentIds }) : await api('chat.send', { conversationId: convId, text, model, attachmentIds })
      if (attachmentIds.length) set({ attachments: get().attachments.filter((a) => !attachmentIds.includes(a.id)) })
      const msgs = get().messages[convId] ?? []
      set({
        messages: { ...get().messages, [convId]: [...msgs, toChatMessage(r.message)] },
        conversations: [r.conversation, ...get().conversations.filter((c) => c.id !== convId)],
        live: { ...get().live, [convId]: { kind, taskId: r.taskId, model, text: '', state: 'prompt', startedAt: Date.now(), changes: {} } },
      })
      if (kind === 'agent') useLayout.getState().show('activity')
      return true
    } catch (e) {
      report('No se pudo enviar el mensaje')(e)
      return false
    }
  },

  cancel: async (conversationId) => {
    const l = get().live[conversationId]
    if (l) await api(l.kind === 'agent' ? 'agent.cancel' : 'chat.cancel', { taskId: l.taskId }).catch(() => {})
  },

  initStreaming: async () => {
    if (!hasBackend) return
    // Progreso y resultado de la extracción de cada adjunto
    onEvent('attachments.updated', (row) => {
      useAttachments.getState().upsert([row])
      if (get().attachments.some((a) => a.id === row.id)) set({ attachments: get().attachments.map((a) => (a.id === row.id ? toMeta(row) : a)) })
    })
    onEvent('chat.event', (e: ChatEvent) => {
      const live = get().live[e.conversationId]
      if (e.type === 'delta' && live) set({ live: { ...get().live, [e.conversationId]: { ...live, text: live.text + (e.text ?? ''), state: 'generating' } } })
      else if (e.type === 'state' && live && e.state) set({ live: { ...get().live, [e.conversationId]: { ...live, state: e.state } } })
      else if (e.type === 'done' || e.type === 'cancelled' || e.type === 'error') {
        const rest = { ...get().live }
        delete rest[e.conversationId]
        const patch: Partial<ChatStore> = { live: rest }
        if (e.message && get().messages[e.conversationId]) patch.messages = { ...get().messages, [e.conversationId]: [...get().messages[e.conversationId]!, toChatMessage(e.message)] }
        if (e.metrics) patch.lastMetrics = { ...e.metrics, model: e.message?.model ?? live?.model ?? '' }
        patch.conversations = get().conversations.map((c) => (c.id === e.conversationId ? { ...c, updatedAt: Date.now(), messageCount: c.messageCount + 1 } : c))
        set(patch)
      }
    })
    onEvent('agent.event', (e: AgentStream) => {
      const live = get().live[e.conversationId]
      const patchLive = (p: Partial<LiveReply>) => live && set({ live: { ...get().live, [e.conversationId]: { ...live, ...p } } })
      if (e.kind === 'event') {
        const ev = e.event as AgentEvent
        useActivity.getState().dispatchReal(e.taskId, ev)
        if (ev.type === 'model.state' && ev.state !== 'idle') patchLive({ state: ev.state === 'waiting_approval' ? 'approval' : ev.state })
      } else if (e.kind === 'text') patchLive({ text: (live?.text ?? '') + (e.text ?? ''), state: 'generating' })
      else if (e.kind === 'change' && e.change) patchLive({ changes: { ...(live?.changes ?? {}), [e.change.rel]: e.change } })
      else if (e.kind === 'done') {
        void import('./workspace').then(({ useWorkspace }) => useWorkspace.getState().loadPending())
        const rest = { ...get().live }
        delete rest[e.conversationId]
        const patch: Partial<ChatStore> = { live: rest }
        if (e.message && get().messages[e.conversationId]) patch.messages = { ...get().messages, [e.conversationId]: [...get().messages[e.conversationId]!, toChatMessage(e.message)] }
        patch.conversations = get().conversations.map((c) => (c.id === e.conversationId ? { ...c, updatedAt: Date.now(), messageCount: c.messageCount + 1 } : c))
        set(patch)
      }
    })
    // Recuperar respuestas y tareas en curso tras recargar la ventana
    const [chats, agents] = await Promise.all([api('chat.active').catch(() => []), api('agent.active').catch(() => [])])
    const restore = (kind: 'chat' | 'agent') => (a: { taskId: string; conversationId: string; model: string; text: string }) => [a.conversationId, { kind, taskId: a.taskId, model: a.model, text: a.text, state: 'generating' as ModelPhase, startedAt: Date.now(), changes: {} }]
    set({ live: Object.fromEntries([...chats.map(restore('chat')), ...agents.map(restore('agent'))]) })
  },
}))
