import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { CircleAlert, CircleCheck, CircleMinus, Lock, TriangleAlert } from 'lucide-react'
import type { AttachmentPreview as PreviewData } from '@shared/ipc/contract'
import { Dialog } from '@renderer/components/ui/overlays'
import { Spinner } from '@renderer/components/ui/primitives'
import { cn } from '@renderer/lib/cn'
import { api, errorMessage } from '@renderer/lib/api'
import { formatBytes } from '@renderer/lib/format'
import { toMeta, useAttachments } from '@renderer/stores/attachments'
import { toast } from '@renderer/stores/ui'
import type { AttachmentMeta } from '@renderer/demo/conversations'
import { attachmentDetails } from './AttachmentCard'

const usePreviewStore = create<{ item: AttachmentMeta | null; set: (a: AttachmentMeta | null) => void }>((set) => ({
  item: null,
  set: (item) => set({ item }),
}))

/** Devuelve una función para abrir la vista previa de un adjunto (contenido extraído real). */
export function usePreview() {
  const set = usePreviewStore((s) => s.set)
  return (a: AttachmentMeta) => {
    if (a.stored || a.previewUrl) return set(a)
    if (a.status === 'error') return toast({ tone: 'error', title: a.name, description: a.error ?? 'No se pudo procesar' })
    toast({ tone: 'info', title: 'Vista previa no disponible', description: 'Los adjuntos de la demostración son de ejemplo. Abre un proyecto real para adjuntar archivos.' })
  }
}

export function AttachmentPreview() {
  const item = usePreviewStore((s) => s.item)
  const set = usePreviewStore((s) => s.set)
  // Estado en vivo (si se está procesando, se actualiza solo)
  const live = useAttachments((s) => (item?.stored ? s.rows[item.id] : undefined))
  const a = live ? toMeta(live) : item
  const [data, setData] = useState<PreviewData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sheet, setSheet] = useState(0)

  useEffect(() => {
    setData(null)
    setError(null)
    setSheet(0)
    if (!a?.stored || a.status !== 'ready') return
    let cancelled = false
    api('attachments.preview', { id: a.id }).then(
      (d) => !cancelled && setData(d),
      (e) => !cancelled && setError(errorMessage(e)),
    )
    return () => {
      cancelled = true
    }
  }, [a?.id, a?.status, a?.stored])

  const details = a ? attachmentDetails(a) : []
  return (
    <Dialog
      open={!!item}
      onClose={() => set(null)}
      title={a?.name}
      width={940}
      footer={
        <span className="mr-auto flex items-center gap-1.5 text-small text-fg-3">
          <Lock className="size-3.5" /> Solo lectura · guardado en este equipo · el agente puede leerlo, no modificarlo
        </span>
      }
    >
      {a && (
        <div className="flex max-h-[70vh] min-h-0 flex-col">
          <div className="flex flex-wrap items-center gap-1.5 border-b border-line-subtle px-5 py-2.5 text-small text-fg-2">
            <Chip>{a.ext ? a.ext.toUpperCase() : 'Archivo'}</Chip>
            <Chip>{formatBytes(a.size)}</Chip>
            {details.map((d) => (
              <Chip key={d}>{d}</Chip>
            ))}
          </div>
          {a.meta?.warnings?.map((w) => (
            <div key={w} className="mx-5 mt-3 flex items-start gap-2 rounded-md border border-warn/30 bg-warn-soft px-3 py-2 text-small text-fg-1">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warn" /> {w}
            </div>
          ))}
          <div className="min-h-0 flex-1 overflow-auto px-5 py-3">
            {a.status === 'error' ? (
              <Notice icon={<CircleAlert className="size-4 text-err" />}>{a.error ?? 'No se pudo procesar el archivo.'}</Notice>
            ) : a.status !== 'ready' ? (
              <Notice icon={<Spinner tone="accent" />}>{a.progress ?? (a.status === 'queued' ? 'Guardando el archivo…' : 'Extrayendo el contenido…')}</Notice>
            ) : error ? (
              <Notice icon={<CircleAlert className="size-4 text-err" />}>{error}</Notice>
            ) : !a.stored ? (
              a.previewUrl && <img src={a.previewUrl} alt={a.name} className="mx-auto max-h-[60vh] max-w-full rounded-md object-contain ring-1 ring-line" />
            ) : !data ? (
              <Notice icon={<Spinner tone="accent" />}>Cargando…</Notice>
            ) : (
              <Body a={a} data={data} sheet={sheet} setSheet={setSheet} />
            )}
          </div>
        </div>
      )}
    </Dialog>
  )
}

function Body({ a, data, sheet, setSheet }: { a: AttachmentMeta; data: PreviewData; sheet: number; setSheet: (n: number) => void }) {
  if (a.kind === 'image')
    return (
      <div className="space-y-3">
        {data.image && <img src={data.image} alt={a.name} className="mx-auto max-h-[52vh] max-w-full rounded-md object-contain ring-1 ring-line" />}
        {data.text && <TextBlock text={data.text} title={a.ext === 'svg' ? 'Código' : 'Texto reconocido (OCR)'} />}
      </div>
    )
  if (data.sheets?.length) {
    const s = data.sheets[Math.min(sheet, data.sheets.length - 1)]!
    return (
      <div>
        {data.sheets.length > 1 && (
          <div className="mb-2 flex flex-wrap gap-1">
            {data.sheets.map((sh, i) => (
              <button key={sh.name + i} type="button" onClick={() => setSheet(i)} className={cn('rounded-md px-2.5 py-1 text-small', i === sheet ? 'bg-accent-soft text-accent' : 'text-fg-3 hover:bg-bg-2 hover:text-fg-1')}>
                {sh.name}
              </button>
            ))}
          </div>
        )}
        <div className="overflow-auto rounded-md border border-line">
          <table className="w-max min-w-full border-collapse font-mono text-tiny">
            <tbody>
              {s.rows.map((r, ri) => (
                <tr key={ri} className={ri === 0 ? 'sticky top-0 bg-bg-3 text-fg-1' : 'odd:bg-bg-1'}>
                  <td className="border-r border-line-subtle px-2 py-1 text-right text-fg-3 select-none">{ri + 1}</td>
                  {r.map((c, ci) => (
                    <td key={ci} className="max-w-72 truncate border-r border-line-subtle px-2 py-1 text-fg-2" title={c}>
                      {c}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-2 text-tiny text-fg-3">Vista previa de las primeras 200 filas y 40 columnas. El modelo recibe la hoja completa.</div>
      </div>
    )
  }
  if (data.entries) {
    return (
      <div className="space-y-0.5">
        {data.entries.map((e) => (
          <div key={e.path} className="flex items-center gap-2 rounded px-1.5 py-1 text-small hover:bg-bg-2">
            {e.status === 'ok' ? <CircleCheck className="size-3.5 shrink-0 text-ok" /> : e.status === 'rejected' ? <CircleAlert className="size-3.5 shrink-0 text-err" /> : <CircleMinus className="size-3.5 shrink-0 text-fg-3" />}
            <span className={cn('min-w-0 truncate font-mono', e.status === 'ok' ? 'text-fg-1' : 'text-fg-3')}>{e.path}</span>
            {e.reason && <span className={cn('shrink-0 text-tiny', e.status === 'rejected' ? 'text-err' : 'text-fg-3')}>{e.reason}</span>}
            <span className="ml-auto shrink-0 font-mono text-tiny text-fg-3">{formatBytes(e.size)}</span>
          </div>
        ))}
      </div>
    )
  }
  return <TextBlock text={data.text ?? ''} truncated={data.truncated} />
}

function TextBlock({ text, title, truncated }: { text: string; title?: string; truncated?: boolean }) {
  return (
    <div>
      {title && <div className="mb-1.5 text-micro font-semibold tracking-[0.07em] text-fg-3 uppercase">{title}</div>}
      <pre className="selectable rounded-md border border-line-subtle bg-bg-0 p-3 font-mono text-tiny leading-5 whitespace-pre-wrap text-fg-2">{text || '(sin texto)'}</pre>
      {truncated && <div className="mt-2 text-tiny text-fg-3">Vista previa recortada. El agente puede leer el resto con read_attachment.</div>}
    </div>
  )
}

function Chip({ children }: { children: React.ReactNode }) {
  return <span className="rounded-md bg-bg-3 px-2 py-0.5 text-tiny text-fg-2">{children}</span>
}

function Notice({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return <div className="flex items-center justify-center gap-2 py-10 text-small text-fg-2">{icon}{children}</div>
}
