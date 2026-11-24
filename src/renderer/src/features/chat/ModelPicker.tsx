import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronRight, Download, Search } from 'lucide-react'
import { estimateFit, GEMMA4_VARIANTS } from '@shared/models/catalog'
import { Kbd, Spinner } from '@renderer/components/ui/primitives'
import { cn } from '@renderer/lib/cn'
import { formatBytes } from '@renderer/lib/format'
import { MOD } from '@renderer/lib/platform'
import { catalogHardware, isInstalled, useOllama } from '@renderer/stores/ollama'
import { useSettings } from '@renderer/stores/settings'
import { useUI } from '@renderer/stores/ui'

const CAP_LABEL: Record<string, string> = { tools: 'Herramientas', vision: 'Visión', thinking: 'Razona', audio: 'Audio' }

/** Selector de modelo del composer (referencia de diseño, página 7). */
export function ModelPicker({ anchor, onClose }: { anchor: HTMLElement; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [q, setQ] = useState('')
  const [pos, setPos] = useState({ left: 0, bottom: 0 })
  const installed = useOllama((s) => s.installed)
  const loaded = useOllama((s) => s.loaded)
  const pulls = useOllama((s) => s.pulls)
  const hardware = useOllama((s) => s.hardware)
  const connected = useOllama((s) => s.status?.state === 'connected')
  const active = useSettings((s) => s.activeModel)
  const temperature = useSettings((s) => s.temperature)
  const numCtx = useSettings((s) => s.numCtx)
  const hw = catalogHardware(hardware)

  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect()
    setPos({ left: Math.min(r.left, window.innerWidth - 470), bottom: window.innerHeight - r.top + 8 })
  }, [anchor])

  useEffect(() => {
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && !anchor.contains(e.target as Node) && onClose()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [anchor, onClose])

  const match = (name: string) => !q || name.toLowerCase().includes(q.toLowerCase())
  const local = useMemo(() => installed.filter((m) => match(m.name)), [installed, q]) // eslint-disable-line react-hooks/exhaustive-deps
  const downloadable = GEMMA4_VARIANTS.filter((v) => !isInstalled(installed, v.tag) && match(v.tag) && v.quant === 'QAT')

  const choose = (name: string) => {
    useSettings.getState().set('activeModel', name)
    onClose()
  }

  return createPortal(
    <div ref={ref} style={{ left: pos.left, bottom: pos.bottom }} className="fixed z-[90] w-[460px] animate-pop-in overflow-hidden rounded-xl border border-line bg-bg-2 shadow-pop">
      <div className="flex h-11 items-center gap-2 border-b border-line-subtle px-3.5">
        <Search className="size-4 text-fg-3" />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar modelo…" className="flex-1 bg-transparent text-body text-fg-1 outline-none placeholder:text-fg-3" />
        <Kbd className="border-line-subtle">{MOD} M</Kbd>
      </div>
      <div className="max-h-[360px] overflow-y-auto p-1.5">
        <div className="px-2.5 pt-1.5 pb-1 text-micro font-medium tracking-[0.06em] text-fg-3 uppercase">En este equipo</div>
        {!connected && <div className="px-2.5 py-2 text-small text-fg-3">Ollama no está conectado: no se pueden listar los modelos.</div>}
        {connected && local.length === 0 && <div className="px-2.5 py-2 text-small text-fg-3">Aún no hay modelos descargados.</div>}
        {local.map((m) => {
          const inMem = loaded.some((l) => l.name === m.name)
          const variant = GEMMA4_VARIANTS.find((v) => v.tag === m.name)
          const fits = !variant || estimateFit(variant, hw) !== 'no-memory'
          return (
            <button
              key={m.name}
              type="button"
              onClick={() => choose(m.name)}
              className={cn('grid w-full grid-cols-[16px_1fr_auto] items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-bg-3', m.name === active && 'bg-bg-3')}
            >
              {m.name === active ? <Check className="size-4 text-accent" /> : <span />}
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono text-body text-fg-1">{m.name}</span>
                  {m.capabilities
                    .filter((c) => CAP_LABEL[c])
                    .map((c) => (
                      <span key={c} className="rounded-[4px] border border-line px-1.5 text-micro text-fg-2">
                        {CAP_LABEL[c]}
                      </span>
                    ))}
                  {m.contextLength && <span className="rounded-[4px] border border-line px-1.5 font-mono text-micro text-fg-2">{Math.round(m.contextLength / 1024)}K</span>}
                </span>
                <span className="block text-small text-fg-3">
                  {[m.parameterSize, m.quantization, formatBytes(m.sizeBytes)].filter(Boolean).join(' · ')}
                  {!fits && <span className="text-warn"> · necesita más memoria</span>}
                </span>
              </span>
              <span className={cn('flex items-center gap-1.5 text-small', inMem ? 'text-fg-2' : 'text-fg-3')}>
                {inMem && <span className="size-1.5 rounded-full bg-ok" />}
                {inMem ? 'En memoria' : 'En disco'}
              </span>
            </button>
          )
        })}

        {downloadable.length > 0 && (
          <>
            <div className="mt-1 border-t border-line-subtle px-2.5 pt-2.5 pb-1 text-micro font-medium tracking-[0.06em] text-fg-3 uppercase">Disponibles para descargar</div>
            {downloadable.map((v) => {
              const fit = estimateFit(v, hw)
              const pull = pulls[v.tag]
              const pct = pull && pull.total ? Math.round((pull.completed / pull.total) * 100) : 0
              return (
                <div key={v.tag} className="grid grid-cols-[16px_1fr_auto] items-center gap-2.5 rounded-lg px-2.5 py-2">
                  <span />
                  <span className="min-w-0">
                    <span className="block font-mono text-body text-fg-1">{v.tag}</span>
                    <span className={cn('block text-small', fit === 'no-memory' ? 'text-warn' : 'text-fg-3')}>{fit === 'no-memory' ? `No cabe en ${Math.round(hw.ramGB)} GB` : fit === 'tight' ? 'Muy justo en este equipo' : v.note}</span>
                  </span>
                  {pull && !['done', 'error', 'cancelled'].includes(pull.phase) ? (
                    <span className="flex items-center gap-1.5 font-mono text-small text-accent">
                      <Spinner size={11} tone="accent" /> {pct} %
                    </span>
                  ) : (
                    <button
                      type="button"
                      disabled={!connected || fit === 'no-memory'}
                      onClick={() => void useOllama.getState().pull(v.tag)}
                      className="flex h-7 items-center gap-1.5 rounded-md border border-line px-2.5 font-mono text-small text-fg-1 hover:bg-bg-3 disabled:opacity-40"
                    >
                      <Download className="size-3.5" />
                      {v.downloadGB.toLocaleString('es-ES')} GB
                    </button>
                  )}
                </div>
              )
            })}
          </>
        )}
      </div>
      <div className="flex items-center gap-2 border-t border-line-subtle px-3.5 py-2.5 text-small">
        <span className="font-mono text-tiny text-fg-3">
          temp {temperature.toLocaleString('es-ES')} · ctx {Math.round(numCtx / 1024)}K ·
        </span>
        <button type="button" className="text-accent hover:underline" onClick={() => useUI.getState().openDialog('settings', 'context')}>
          Parámetros
        </button>
        <button type="button" className="ml-auto flex items-center gap-1 text-fg-2 hover:text-fg-1" onClick={() => useUI.getState().openDialog('settings', 'ollama')}>
          Gestionar en Ollama <ChevronRight className="size-3.5" />
        </button>
      </div>
    </div>,
    document.body,
  )
}
