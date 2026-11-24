import { FileArchive, FileCode, FileSpreadsheet, FileText, File, X, Image } from 'lucide-react'
import { Tooltip } from '@renderer/components/ui/Tooltip'
import { Spinner } from '@renderer/components/ui/primitives'
import { cn } from '@renderer/lib/cn'
import { formatBytes, middleTruncate } from '@renderer/lib/format'
import type { AttachmentMeta } from '@renderer/demo/conversations'

const KIND_STYLE: Record<AttachmentMeta['kind'], { icon: typeof File; cls: string; label: string }> = {
  pdf: { icon: FileText, cls: 'bg-err/12 text-[#F48C95]', label: 'PDF' },
  doc: { icon: FileText, cls: 'bg-accent/12 text-[#7FB2FF]', label: 'Documento' },
  text: { icon: FileText, cls: 'bg-bg-4 text-fg-2', label: 'Texto' },
  sheet: { icon: FileSpreadsheet, cls: 'bg-ok/12 text-[#6BD3A3]', label: 'Hoja de cálculo' },
  image: { icon: Image, cls: 'bg-agent/12 text-agent', label: 'Imagen' },
  code: { icon: FileCode, cls: 'bg-bg-4 text-fg-2', label: 'Código' },
  archive: { icon: FileArchive, cls: 'bg-warn/12 text-warn', label: 'ZIP' },
  other: { icon: File, cls: 'bg-bg-4 text-fg-3', label: 'Archivo' },
}

/** Resumen de lo extraído para la tarjeta y su tooltip. */
export function attachmentDetails(a: AttachmentMeta): string[] {
  const m = a.meta
  if (!m) return []
  const out: string[] = []
  if (m.pages) out.push(`${m.pages} página${m.pages === 1 ? '' : 's'}`)
  if (m.sheets?.length) out.push(m.sheets.length === 1 ? `${m.sheets[0]!.rows} filas × ${m.sheets[0]!.cols} columnas` : `${m.sheets.length} hojas`)
  if (m.width && m.height) out.push(`${m.width}×${m.height} px`)
  if (m.ocr) out.push(a.kind === 'pdf' ? `OCR en ${m.ocr.pages} página${m.ocr.pages === 1 ? '' : 's'} (${m.ocr.confidence} %)` : `OCR ${m.ocr.confidence} %`)
  if (m.entries !== undefined) out.push(`${m.entries} archivo${m.entries === 1 ? '' : 's'}${m.rejected ? ` · ${m.rejected} rechazado${m.rejected === 1 ? '' : 's'}` : ''}`)
  if (m.encoding && m.encoding !== 'UTF-8') out.push(m.encoding)
  if (m.chars !== undefined && a.kind !== 'image') out.push(`${m.chars.toLocaleString('es-ES')} caracteres`)
  return out
}

function statusOf(a: AttachmentMeta): { label: string; cls: string; tip?: string; busy?: boolean } {
  switch (a.status) {
    case 'queued':
      return { label: 'Subiendo…', cls: 'text-accent', busy: true }
    case 'processing':
      return { label: a.progress ?? 'Procesando…', cls: 'text-accent', busy: true }
    case 'ready':
      return { label: 'Listo', cls: 'text-ok', tip: [KIND_STYLE[a.kind].label, ...attachmentDetails(a), ...(a.meta?.warnings ?? [])].join(' · ') }
    case 'error':
      return { label: 'Error', cls: 'text-err', tip: a.error ?? 'No se pudo procesar' }
  }
}

export function AttachmentCard({ a, onRemove, onOpen, compact }: { a: AttachmentMeta; onRemove?: () => void; onOpen?: () => void; compact?: boolean }) {
  const k = KIND_STYLE[a.kind]
  const s = statusOf(a)
  const img = a.thumb ?? a.previewUrl
  return (
    <div
      className={cn(
        'group flex min-w-0 animate-pop-in items-center gap-2 rounded-md border bg-bg-1 py-1.5 pr-1.5 pl-1.5',
        a.status === 'error' ? 'border-err/40' : a.meta?.warnings?.length ? 'border-warn/40' : 'border-line',
        compact ? 'max-w-60' : 'max-w-64',
      )}
    >
      <button type="button" onClick={onOpen} className="shrink-0" aria-label={`Vista previa de ${a.name}`}>
        {img ? (
          <img src={img} alt="" className="size-7 rounded-[5px] object-cover ring-1 ring-line-strong" />
        ) : (
          <span className={cn('grid size-7 place-items-center rounded-[5px]', k.cls)}>
            <k.icon className="size-3.5" />
          </span>
        )}
      </button>
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
        <div className="truncate text-small text-fg-1" title={a.name}>
          {middleTruncate(a.name, 28)}
        </div>
        <div className="flex min-w-0 items-center gap-1 text-[11px] text-fg-3">
          <span className="shrink-0 uppercase">{a.ext || '—'}</span>·<span className="shrink-0">{formatBytes(a.size)}</span>·
          <Tooltip content={s.tip}>
            <span className={cn('flex min-w-0 items-center gap-1 truncate', s.cls)}>
              {s.busy && <Spinner size={9} tone="accent" />}
              <span className="truncate">{s.label}</span>
            </span>
          </Tooltip>
        </div>
      </button>
      {onRemove && (
        <button type="button" aria-label={`Quitar ${a.name}`} onClick={onRemove} className="grid size-5 shrink-0 place-items-center rounded-sm text-fg-3 hover:bg-bg-3 hover:text-fg-1">
          <X className="size-3.5" />
        </button>
      )}
    </div>
  )
}
