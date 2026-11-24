import { useShallow } from 'zustand/react/shallow'
import { Paperclip, Upload } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { Dialog } from '@renderer/components/ui/overlays'
import { Button } from '@renderer/components/ui/Button'
import { EmptyState } from '@renderer/components/ui/primitives'
import { AttachmentCard } from '@renderer/features/chat/AttachmentCard'
import { ACCEPT } from '@renderer/features/chat/Composer'
import { usePreview } from '@renderer/features/chat/preview'
import { useChat } from '@renderer/stores/chat'
import { toMeta, useAttachments } from '@renderer/stores/attachments'
import { useUI } from '@renderer/stores/ui'

/** Adjuntos de la conversación: contexto para el modelo, nunca modificables por el agente. */
export function AttachmentsDialog() {
  const open = useUI((s) => s.dialog === 'attachments')
  const close = useUI((s) => s.closeDialog)
  const pending = useChat((s) => s.attachments)
  const activeId = useChat((s) => s.activeId)
  const demo = useChat((s) => s.demo)
  const fromMessages = useChat(useShallow((s) => (s.activeId ? (s.messages[s.activeId] ?? []) : []).flatMap((m) => m.attachments ?? [])))
  const rows = useAttachments((s) => s.rows)
  // Estado guardado (miniatura, páginas, OCR) de los adjuntos enviados en esta conversación
  useEffect(() => {
    if (open && activeId && !demo) void useAttachments.getState().loadConversation(activeId)
  }, [open, activeId, demo])
  const sent = fromMessages.map((a) => (rows[a.id] ? toMeta(rows[a.id]!) : a))
  const fileRef = useRef<HTMLInputElement>(null)
  const preview = usePreview()

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Adjuntos"
      icon={<Paperclip />}
      width={640}
      footer={
        <>
          <input ref={fileRef} type="file" multiple hidden accept={ACCEPT} onChange={(e) => { useChat.getState().addFiles(Array.from(e.target.files ?? [])); e.target.value = '' }} />
          <Button icon={<Upload />} onClick={() => fileRef.current?.click()}>
            Añadir archivos
          </Button>
        </>
      }
    >
      <div className="px-5 py-3 text-small text-fg-3">
        Los adjuntos son contexto para la IA: puede leerlos pero no modificarlos, y se guardan solo en este equipo. Son independientes de los archivos del proyecto.
      </div>
      {pending.length + sent.length === 0 ? (
        <EmptyState icon={<Paperclip />} title="Sin adjuntos" description="Arrastra archivos sobre el chat o usa el clip del cuadro de mensaje." />
      ) : (
        <div className="space-y-4 px-5 pb-5">
          {pending.length > 0 && (
            <div>
              <div className="mb-2 text-micro font-semibold tracking-[0.07em] text-fg-3 uppercase">Pendientes de enviar</div>
              <div className="flex flex-wrap gap-2">
                {pending.map((a) => (
                  <AttachmentCard key={a.id} a={a} onRemove={() => useChat.getState().removeAttachment(a.id)} onOpen={() => preview(a)} />
                ))}
              </div>
            </div>
          )}
          {sent.length > 0 && (
            <div>
              <div className="mb-2 text-micro font-semibold tracking-[0.07em] text-fg-3 uppercase">En esta conversación</div>
              <div className="flex flex-wrap gap-2">
                {sent.map((a) => (
                  <AttachmentCard key={a.id} a={a} onOpen={() => preview(a)} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </Dialog>
  )
}
