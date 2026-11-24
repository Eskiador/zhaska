import { useEffect, useMemo, useState } from 'react'
import { Check, Cpu, Download, Info, X } from 'lucide-react'
import { estimateFit, GEMMA4_VARIANTS, recommendVariant, type Fit, type ModelVariant } from '@shared/models/catalog'
import type { PullProgress } from '@shared/ipc/contract'
import { Dialog } from '@renderer/components/ui/overlays'
import { Button } from '@renderer/components/ui/Button'
import { Spinner } from '@renderer/components/ui/primitives'
import { cn } from '@renderer/lib/cn'
import { formatBytes } from '@renderer/lib/format'
import { hasBackend } from '@renderer/lib/api'
import { catalogHardware, isInstalled, useOllama } from '@renderer/stores/ollama'
import { useSettings } from '@renderer/stores/settings'
import { useUI } from '@renderer/stores/ui'

const VARIANTS = GEMMA4_VARIANTS.filter((v) => v.quant === 'QAT')
const TITLE: Record<string, string> = { E2B: 'Gemma 4 E2B', E4B: 'Gemma 4 E4B', '12B': 'Gemma 4 12B', '26B A4B': 'Gemma 4 26B A4B', '31B': 'Gemma 4 31B' }

const PHASES: { id: PullProgress['phase']; label: string }[] = [
  { id: 'manifest', label: 'Manifiesto' },
  { id: 'layers', label: 'Capas del modelo' },
  { id: 'verify', label: 'Verificar sha256' },
  { id: 'register', label: 'Registrar en Ollama' },
]
const ORDER: PullProgress['phase'][] = ['manifest', 'layers', 'verify', 'register', 'done']

/** Descargar Gemma 4 (referencia de diseño, página 4). */
export function ModelsDialog() {
  const open = useUI((s) => s.dialog === 'models')
  const close = useUI((s) => s.closeDialog)
  const hardware = useOllama((s) => s.hardware)
  const installed = useOllama((s) => s.installed)
  const pulls = useOllama((s) => s.pulls)
  const connected = useOllama((s) => s.status?.state === 'connected')
  const active = useSettings((s) => s.activeModel)
  const hw = catalogHardware(hardware)
  const recommended = useMemo(() => recommendVariant(hw), [hw.vramGB, hw.ramGB, hw.unified]) // eslint-disable-line react-hooks/exhaustive-deps
  const [selected, setSelected] = useState(recommended.tag)

  useEffect(() => {
    if (open) setSelected(Object.keys(pulls)[0] ?? recommended.tag)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const variant = VARIANTS.find((v) => v.tag === selected)!
  const pull = pulls[selected]
  const downloading = !!pull && !['done', 'error', 'cancelled'].includes(pull.phase)
  const isDone = isInstalled(installed, selected)

  return (
    <Dialog open={open} onClose={close} width={820} bare>
      <div className="flex items-start gap-4 px-6 pt-6 pb-4">
        <span className="grid size-11 shrink-0 place-items-center rounded-xl border border-line bg-accent-soft text-accent">
          <Download className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-title font-semibold">Descargar Gemma 4</div>
          <div className="text-body text-fg-3">Modelos abiertos de Google DeepMind, ejecutados en local a través de Ollama.</div>
        </div>
        <button type="button" aria-label="Cerrar" onClick={close} className="grid size-7 place-items-center rounded-md text-fg-3 hover:bg-bg-3 hover:text-fg-1">
          <X className="size-4" />
        </button>
      </div>

      <div className="mx-6 flex items-center gap-2 rounded-lg border border-line-subtle bg-bg-0 px-3.5 py-2.5 text-small text-fg-2">
        <Cpu className="size-4 text-fg-3" />
        <span className="truncate">{hw.label}</span>
        {hardware?.diskFreeGB != null && <span className="text-fg-3">· {Math.round(hardware.diskFreeGB)} GB libres</span>}
        <span className="ml-auto shrink-0 text-fg-3">{hw.detected ? 'Detectado automáticamente' : 'Equipo de referencia'}</span>
      </div>

      <div className="mt-3 px-4">
        {VARIANTS.map((v) => (
          <VariantRow
            key={v.tag}
            v={v}
            fit={estimateFit(v, hw)}
            recommended={v.tag === recommended.tag}
            installed={isInstalled(installed, v.tag)}
            active={v.tag === active}
            selected={v.tag === selected}
            ramGB={hw.ramGB}
            onSelect={() => setSelected(v.tag)}
          />
        ))}
      </div>

      {pull && (
        <div className="mx-6 mt-3 rounded-[10px] border border-line-subtle bg-bg-0 p-4">
          <div className="flex items-center gap-2.5 text-body">
            {downloading ? <Spinner tone="accent" /> : pull.phase === 'done' ? <Check className="size-4 text-ok" /> : <X className="size-4 text-err" />}
            <span className="text-fg-1">
              {downloading ? 'Descargando' : pull.phase === 'done' ? 'Descargado' : pull.phase === 'cancelled' ? 'Descarga cancelada' : 'Error al descargar'} <span className="font-mono">{pull.name}</span>
              {pull.source === 'huggingface' && <span className="ml-2 rounded-sm bg-bg-3 px-1.5 py-px text-tiny text-fg-2">Hugging Face</span>}
            </span>
            <span className="ml-auto font-mono text-small text-fg-3">{progressLine(pull)}</span>
          </div>
          {pull.source === 'huggingface' && (
            <div className="mt-2 flex items-start gap-2 rounded-md bg-bg-2 px-2.5 py-1.5 text-small text-fg-2">
              <Info className="mt-0.5 size-3.5 shrink-0 text-accent" />
              {pull.note ?? 'Descargando la versión oficial de Google desde Hugging Face.'}
            </div>
          )}
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-bg-4">
            <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${pull.phase === 'done' ? 100 : pull.total ? (pull.completed / pull.total) * 100 : 2}%` }} />
          </div>
          <div className="mt-3 grid grid-cols-4 gap-2 text-small">
            {PHASES.map((ph) => {
              const cur = ORDER.indexOf(pull.phase)
              const idx = ORDER.indexOf(ph.id)
              const state = pull.phase === 'done' || cur > idx ? 'done' : cur === idx && downloading ? 'running' : 'pending'
              return (
                <span key={ph.id} className={cn('flex items-center gap-1.5', state === 'pending' ? 'text-fg-3' : 'text-fg-1')}>
                  {state === 'done' ? (
                    <span className="grid size-4 place-items-center rounded-full bg-ok-soft text-ok">
                      <Check className="size-2.5" strokeWidth={3} />
                    </span>
                  ) : state === 'running' ? (
                    <Spinner size={14} tone="accent" />
                  ) : (
                    <span className="size-4 rounded-full border border-dashed border-line-strong" />
                  )}
                  {ph.id === 'register' && pull.source === 'huggingface' ? 'Preparar para Ollama' : ph.label}
                  {ph.id === 'layers' && state === 'running' && pull.total ? ` · ${Math.round((pull.completed / pull.total) * 100)} %` : ''}
                </span>
              )
            })}
          </div>
          {pull.error && <div className="mt-2 text-small text-err">{pull.error}</div>}
        </div>
      )}

      <div className="mt-5 flex items-center gap-3 border-t border-line-subtle px-6 py-4">
        <span className="flex items-center gap-1.5 text-small text-fg-3">
          <Info className="size-3.5" />
          {!hasBackend ? 'Disponible en la aplicación de escritorio.' : !connected ? 'Ollama no está conectado.' : 'Puedes seguir usando ZHASKA mientras se descarga.'}
        </span>
        <div className="ml-auto flex gap-2">
          {downloading ? (
            <>
              <Button variant="danger" onClick={() => void useOllama.getState().cancelPull(selected)}>
                Cancelar descarga
              </Button>
              <Button variant="primary" onClick={close}>
                Seguir en segundo plano
              </Button>
            </>
          ) : isDone ? (
            <Button
              variant="primary"
              icon={<Check />}
              disabled={selected === active}
              onClick={() => {
                useSettings.getState().set('activeModel', selected)
                close()
              }}
            >
              {selected === active ? 'Modelo activo' : 'Usar este modelo'}
            </Button>
          ) : (
            <Button variant="primary" icon={<Download />} disabled={!connected || estimateFit(variant, hw) === 'no-memory'} onClick={() => void useOllama.getState().pull(selected)}>
              Descargar {variant.downloadGB.toLocaleString('es-ES')} GB
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  )
}

function progressLine(p: PullProgress) {
  if (!p.total) return p.phase === 'manifest' ? 'preparando…' : ''
  const pct = Math.round((p.completed / p.total) * 100)
  const eta = p.bytesPerSec > 0 ? Math.max(0, (p.total - p.completed) / p.bytesPerSec) : null
  const etaText = eta === null ? '' : eta < 60 ? ` · quedan ~${Math.ceil(eta)} s` : ` · quedan ~${Math.ceil(eta / 60)} min`
  return `${pct} % de ${formatBytes(p.total)}${p.bytesPerSec ? ` · ${formatBytes(p.bytesPerSec)}/s` : ''}${etaText}`
}

const BADGE: Record<Fit, { label: (ram: number) => string; cls: string }> = {
  gpu: { label: () => 'Compatible', cls: 'bg-ok-soft text-ok' },
  partial: { label: () => 'Compatible', cls: 'bg-ok-soft text-ok' },
  tight: { label: (r) => `Muy justo en ${Math.round(r)} GB`, cls: 'bg-warn-soft text-warn' },
  'too-slow': { label: () => 'Muy lento aquí', cls: 'bg-warn-soft text-warn' },
  'no-memory': { label: (r) => `No cabe en ${Math.round(r)} GB`, cls: 'bg-bg-3 text-fg-3' },
}

function VariantRow({ v, fit, recommended, installed, active, selected, ramGB, onSelect }: { v: ModelVariant; fit: Fit; recommended: boolean; installed: boolean; active: boolean; selected: boolean; ramGB: number; onSelect: () => void }) {
  const disabled = fit === 'no-memory'
  const badge = installed ? { label: active ? 'Activo' : 'Instalado', cls: 'bg-bg-3 text-fg-1' } : recommended ? { label: 'Recomendado', cls: 'bg-accent-soft text-accent' } : { label: BADGE[fit].label(ramGB), cls: BADGE[fit].cls }
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'grid w-full grid-cols-[18px_1fr_70px_56px_150px] items-center gap-3 rounded-[10px] border px-3 py-2 text-left',
        selected ? 'border-accent/60 bg-accent-soft' : 'border-transparent hover:bg-bg-2',
        disabled && 'opacity-55',
      )}
    >
      <span className={cn('grid size-4 place-items-center rounded-full border', selected ? 'border-accent' : 'border-line-strong')}>{selected && <span className="size-2 rounded-full bg-accent" />}</span>
      <span className="min-w-0">
        <span className="flex items-baseline gap-2">
          <span className="text-body font-medium text-fg-1">{TITLE[v.size]}</span>
          <span className="truncate font-mono text-tiny text-fg-3">{v.tag}</span>
        </span>
        <span className="block truncate text-small text-fg-3">{v.note}</span>
      </span>
      <span className="text-right font-mono text-small text-fg-1">{v.downloadGB.toLocaleString('es-ES')} GB</span>
      <span className="text-right font-mono text-small text-fg-3">{v.contextK}K</span>
      <span className="flex justify-end">
        <span className={cn('rounded-md px-2 py-0.5 text-tiny', badge.cls)}>{badge.label}</span>
      </span>
    </button>
  )
}
