import { create } from 'zustand'
import type { AssistantConversation, AssistantMessage, KbCollection, KbDocument } from '@shared/ipc/contract'
import type { AssistantSource } from '@shared/assistant'
import type { AttachmentMeta } from '@renderer/demo/conversations'
import { ATTACHMENT_LIMITS, extOf, kindOfExt } from '@shared/attachments'
import { api, errorMessage, hasBackend, onEvent } from '@renderer/lib/api'
import { toast } from './ui'
import { toMeta, useAttachments } from './attachments'

/** Respuesta en curso del asistente. */
export interface AssistantLive {
  taskId: string
  model: string
  text: string
  state: 'searching' | 'loading' | 'prompt' | 'thinking' | 'generating'
  sources: AssistantSource[] | null
}

interface AssistantStore {
  ready: boolean
  collections: KbCollection[]
  documents: Record<string, KbDocument[]>
  conversations: AssistantConversation[]
  messages: Record<string, AssistantMessage[]>
  activeId: string | null
  live: Record<string, AssistantLive>
  draft: string
  attachments: AttachmentMeta[]
  /** Base abierta en el diálogo de detalle */
  kbOpen: string | null
  /** Diálogo «Nueva base de conocimiento» */
  newKb: boolean
  setNewKb: (v: boolean) => void
  init: () => Promise<void>
  refreshCollections: () => Promise<void>
  select: (id: string) => Promise<void>
  newConversation: (opts?: { private?: boolean; collectionIds?: string[] }) => Promise<string | null>
  rename: (id: string, title: string) => Promise<void>
  remove: (id: string) => Promise<void>
  setCollections: (ids: string[]) => Promise<void>
  setDraft: (v: string) => void
  addFiles: (files: File[]) => void
  removeAttachment: (id: string) => void
  send: (text: string, model: string) => Promise<boolean>
  cancel: () => Promise<void>
  openKb: (id: string | null) => void
  createCollection: (name: string, confidential: boolean) => Promise<string | null>
  updateCollection: (id: string, patch: { name?: string; confidential?: boolean }) => Promise<void>
  deleteCollection: (id: string) => Promise<void>
  addFolder: (id: string) => Promise<void>
  removeFolder: (folderId: string) => Promise<void>
  reindex: (id: string) => Promise<void>
  loadDocuments: (id: string) => Promise<void>
  openDocument: (documentId: string) => Promise<void>
}

const report = (title: string) => (e: unknown) => toast({ tone: 'error', title, description: errorMessage(e) })
let subscribed = false
let seq = 0

export const useAssistant = create<AssistantStore>((set, get) => ({
  ready: false,
  collections: [],
  documents: {},
  conversations: [],
  messages: {},
  activeId: null,
  live: {},
  draft: '',
  attachments: [],
  kbOpen: null,
  newKb: false,
  setNewKb: (newKb) => set({ newKb }),

  init: async () => {
    if (!hasBackend) return set({ ready: true })
    if (!subscribed) {
      subscribed = true
      onEvent('kb.progress', (p) => {
        const indexing = p.phase === 'idle' ? null : p
        set({ collections: get().collections.map((c) => (c.id === p.collectionId ? { ...c, indexing } : c)) })
        if (p.phase === 'idle') {
          void get().refreshCollections()
          if (get().kbOpen === p.collectionId) void get().loadDocuments(p.collectionId)
        }
      })
      // Progreso de los adjuntos del composer del asistente (el del chat de Código escucha el mismo evento)
      onEvent('attachments.updated', (row) => {
        if (get().attachments.some((a) => a.id === row.id)) set({ attachments: get().attachments.map((a) => (a.id === row.id ? toMeta(row) : a)) })
      })
      onEvent('assistant.event', (e) => {
        const live = get().live[e.conversationId]
        const patchLive = (p: Partial<AssistantLive>) => live && set({ live: { ...get().live, [e.conversationId]: { ...live, ...p } } })
        if (e.type === 'state' && e.state) patchLive({ state: e.state })
        else if (e.type === 'sources') patchLive({ sources: e.sources ?? [] })
        else if (e.type === 'delta') patchLive({ text: (live?.text ?? '') + (e.text ?? ''), state: 'generating' })
        else if (e.type === 'done' || e.type === 'cancelled' || e.type === 'error') {
          const rest = { ...get().live }
          delete rest[e.conversationId]
          const msgs = get().messages[e.conversationId]
          set({
            live: rest,
            ...(e.message && msgs ? { messages: { ...get().messages, [e.conversationId]: [...msgs, e.message] } } : {}),
            conversations: get().conversations.map((c) => (c.id === e.conversationId ? { ...c, updatedAt: Date.now(), messageCount: c.messageCount + 1 } : c)),
          })
        }
      })
    }
    try {
      const [collections, conversations, active] = await Promise.all([api('kb.list'), api('assistant.list'), api('assistant.active').catch(() => [])])
      set({
        ready: true,
        collections,
        conversations,
        live: Object.fromEntries(active.map((a) => [a.conversationId, { taskId: a.taskId, model: a.model, text: a.text, state: 'generating' as const, sources: null }])),
      })
      const current = get().activeId
      if (current && conversations.some((c) => c.id === current)) await get().select(current)
      else if (conversations[0]) await get().select(conversations[0].id)
      else set({ activeId: null })
    } catch (e) {
      set({ ready: true })
      report('No se pudo cargar el asistente')(e)
    }
  },

  refreshCollections: async () => {
    try {
      set({ collections: await api('kb.list') })
    } catch (e) {
      report('No se pudieron cargar las bases de conocimiento')(e)
    }
  },

  select: async (id) => {
    set({ activeId: id })
    if (get().messages[id]) return
    try {
      const rows = await api('assistant.messages', { conversationId: id })
      set({ messages: { ...get().messages, [id]: rows } })
    } catch (e) {
      report('No se pudo abrir la conversación')(e)
    }
  },

  newConversation: async (opts = {}) => {
    const collectionIds = opts.collectionIds ?? get().collections.filter((c) => opts.private || !c.confidential).map((c) => c.id)
    if (!opts.private) {
      const empty = get().conversations.find((c) => !c.private && c.messageCount === 0 && c.title === 'Nueva conversación')
      if (empty) {
        await get().select(empty.id)
        return empty.id
      }
    }
    try {
      const c = await api('assistant.create', { collectionIds, private: !!opts.private })
      set({ conversations: [c, ...get().conversations], messages: { ...get().messages, [c.id]: [] }, activeId: c.id })
      return c.id
    } catch (e) {
      report('No se pudo crear la conversación')(e)
      return null
    }
  },

  rename: async (id, title) => {
    const clean = title.trim()
    if (!clean) return
    try {
      const c = await api('assistant.update', { id, title: clean })
      set({ conversations: get().conversations.map((x) => (x.id === id ? c : x)) })
    } catch (e) {
      report('No se pudo renombrar')(e)
    }
  },

  remove: async (id) => {
    try {
      await api('assistant.delete', { id })
      const rest = get().conversations.filter((c) => c.id !== id)
      const msgs = { ...get().messages }
      delete msgs[id]
      set({ conversations: rest, messages: msgs, activeId: get().activeId === id ? (rest[0]?.id ?? null) : get().activeId })
      const next = get().activeId
      if (next) void get().select(next)
    } catch (e) {
      report('No se pudo eliminar la conversación')(e)
    }
  },

  setCollections: async (ids) => {
    const id = get().activeId
    if (!id) return
    try {
      const c = await api('assistant.update', { id, collectionIds: ids })
      set({ conversations: get().conversations.map((x) => (x.id === id ? c : x)) })
    } catch (e) {
      report('No se pudo cambiar las bases de la conversación')(e)
    }
  },

  setDraft: (draft) => set({ draft }),

  addFiles: (files) => {
    const room = ATTACHMENT_LIMITS.perMessage - get().attachments.length
    if (files.length > room) toast({ tone: 'error', title: `Máximo ${ATTACHMENT_LIMITS.perMessage} adjuntos por mensaje` })
    for (const f of files.slice(0, Math.max(0, room))) {
      const ext = extOf(f.name)
      const kind = kindOfExt(ext)
      const tooBig = f.size > ATTACHMENT_LIMITS.fileBytes
      const local: AttachmentMeta = {
        id: `local-a-${++seq}`,
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
      void f
        .arrayBuffer()
        .then((buf) => api('attachments.upload', { name: f.name, data: new Uint8Array(buf) }))
        .then((row) => {
          useAttachments.getState().upsert([row])
          if (!get().attachments.some((a) => a.id === local.id)) return void api('attachments.remove', { id: row.id }).catch(() => {})
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

  send: async (text, model) => {
    const atts = get().attachments
    if (atts.some((a) => a.status === 'queued' || a.status === 'processing')) {
      toast({ tone: 'info', title: 'Procesando adjuntos', description: 'Espera a que todos estén listos para enviar el mensaje.' })
      return false
    }
    if (atts.some((a) => a.status === 'error')) {
      toast({ tone: 'error', title: 'Hay adjuntos con error', description: 'Quítalos para enviar el mensaje.' })
      return false
    }
    let convId = get().activeId
    if (!convId) convId = await get().newConversation()
    if (!convId || get().live[convId]) return false
    const attachmentIds = atts.map((a) => a.id)
    try {
      const r = await api('assistant.send', { conversationId: convId, text, model, attachmentIds })
      const msgs = get().messages[convId] ?? []
      set({
        attachments: get().attachments.filter((a) => !attachmentIds.includes(a.id)),
        messages: { ...get().messages, [convId]: [...msgs, r.message] },
        conversations: [r.conversation, ...get().conversations.filter((c) => c.id !== convId)],
        live: { ...get().live, [convId]: { taskId: r.taskId, model, text: '', state: 'searching', sources: null } },
      })
      return true
    } catch (e) {
      report('No se pudo enviar el mensaje')(e)
      return false
    }
  },

  cancel: async () => {
    const id = get().activeId
    const l = id ? get().live[id] : undefined
    if (l) await api('assistant.cancel', { taskId: l.taskId }).catch(() => {})
  },

  openKb: (kbOpen) => {
    set({ kbOpen })
    if (kbOpen) void get().loadDocuments(kbOpen)
  },

  createCollection: async (name, confidential) => {
    try {
      const before = new Set(get().collections.map((c) => c.id))
      const list = await api('kb.create', { name, confidential })
      set({ collections: list })
      const created = list.find((c) => !before.has(c.id))
      // Las conversaciones guardadas abiertas la usan desde ya (si no es confidencial)
      const active = get().conversations.find((c) => c.id === get().activeId)
      if (created && active && (active.private || !created.confidential)) await get().setCollections([...active.collectionIds, created.id])
      return created?.id ?? null
    } catch (e) {
      report('No se pudo crear la base de conocimiento')(e)
      return null
    }
  },

  updateCollection: async (id, patch) => {
    try {
      const c = await api('kb.update', { id, ...patch })
      set({ collections: get().collections.map((x) => (x.id === id ? c : x)) })
    } catch (e) {
      report('No se pudo guardar el cambio')(e)
    }
  },

  deleteCollection: async (id) => {
    try {
      await api('kb.delete', { id })
      const [collections, conversations] = await Promise.all([api('kb.list'), api('assistant.list')])
      set({ collections, conversations, kbOpen: get().kbOpen === id ? null : get().kbOpen })
    } catch (e) {
      report('No se pudo borrar la base de conocimiento')(e)
    }
  },

  addFolder: async (id) => {
    try {
      const c = await api('kb.addFolder', { id })
      if (c) set({ collections: get().collections.map((x) => (x.id === id ? c : x)) })
    } catch (e) {
      report('No se pudo añadir la carpeta')(e)
    }
  },

  removeFolder: async (folderId) => {
    try {
      const c = await api('kb.removeFolder', { folderId })
      set({ collections: get().collections.map((x) => (x.id === c.id ? c : x)) })
      void get().loadDocuments(c.id)
    } catch (e) {
      report('No se pudo quitar la carpeta')(e)
    }
  },

  reindex: async (id) => {
    try {
      await api('kb.reindex', { id })
    } catch (e) {
      report('No se pudo actualizar el índice')(e)
    }
  },

  loadDocuments: async (id) => {
    try {
      const docs = await api('kb.documents', { id })
      set({ documents: { ...get().documents, [id]: docs } })
    } catch (e) {
      report('No se pudieron cargar los documentos')(e)
    }
  },

  openDocument: async (documentId) => {
    try {
      await api('kb.openDocument', { documentId })
    } catch (e) {
      report('No se pudo abrir el documento')(e)
    }
  },
}))
