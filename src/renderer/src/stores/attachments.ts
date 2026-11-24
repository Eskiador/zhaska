import { create } from 'zustand'
import type { AttachmentRow } from '@shared/ipc/contract'
import type { AttachmentMeta } from '@renderer/demo/conversations'
import { api } from '@renderer/lib/api'

export type LiveAttachment = AttachmentRow & { progress?: string }

/** Adjuntos guardados (por id): los mensajes los muestran con su miniatura y estado real. */
export const useAttachments = create<{
  rows: Record<string, LiveAttachment>
  upsert: (rows: LiveAttachment[]) => void
  loadConversation: (conversationId: string) => Promise<void>
}>((set, get) => ({
  rows: {},
  upsert: (rows) => {
    if (!rows.length) return
    const next = { ...get().rows }
    for (const r of rows) next[r.id] = r
    set({ rows: next })
  },
  loadConversation: async (conversationId) => {
    const rows = await api('attachments.forConversation', { conversationId }).catch(() => [])
    get().upsert(rows)
  },
}))

export const toMeta = (r: LiveAttachment): AttachmentMeta => ({
  id: r.id,
  name: r.name,
  ext: r.ext,
  size: r.size,
  kind: r.kind,
  status: r.status,
  error: r.error,
  progress: r.status === 'processing' ? r.progress : undefined,
  thumb: r.thumb,
  meta: r.meta,
  stored: true,
})
