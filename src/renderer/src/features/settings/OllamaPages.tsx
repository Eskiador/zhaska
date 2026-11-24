import { useEffect, useState, type ReactNode } from 'react'
import { Copy, Download, Ellipsis, FlaskConical, Play, RefreshCw, RotateCw, Server, Square, Star, Trash } from 'lucide-react'
import type { BenchRecord } from '@shared/ipc/contract'
import { Button } from '@renderer/components/ui/Button'
import { Badge, Select, Spinner } from '@renderer/components/ui/primitives'
import { Dialog, openMenuAt } from '@renderer/components/ui/overlays'
import { confirm } from '@renderer/components/ui/confirm'
import { cn } from '@renderer/lib/cn'
import { api, hasBackend } from '@renderer/lib/api'
import { formatBytes } from '@renderer/lib/format'
import { GEMMA4_VARIANTS } from '@shared/models/catalog'
import { isInstalled, useOllama } from '@renderer/stores/ollama'
import { useSettings } from '@renderer/stores/settings'
import { toast, useUI } from '@renderer/stores/ui'

const GB = 1024 ** 3
const ago = (ts: number) => {
  const m = Math.round((Date.now() - ts) / 60000)
  if (m < 1) return 'hace un momento'
  if (m < 60) return `hace ${m} min`
  const h = Math.round(m / 60)
  if (h < 48) return `hace ${h} h`
  return `hace ${Math.round(h / 24)} días`
}
const until = (ts: number | null) => {
  if (!ts) return ''
  const m = Math.round((ts - Date.now()) / 60000)
  return m <= 0 ? 'se libera en breve' : `se libera en ${m} min`
}

export function StatusBadge() {
  const status = useOllama((s) => s.status)
  const st = status?.state ?? 'checking'
  const map = {
    connected: ['En ejecución', 'ok'],
    checking: ['Comprobando…', 'neutral'],
    starting: ['Iniciando…', 'agent'],
    stopped: ['Detenido', 'warn'],
    'not-installed': ['No instalado', 'err'],
    error: ['Sin respuesta', 'err'],
  } as const
  const [label, tone] = map[st]
  return (
    <Badge tone={tone}>
      {st === 'starting' || st === 'checking' ? <Spinner size={10} tone="muted" /> : <span className={cn('size-1.5 rounded-full', st === 'connected' ? 'bg-ok' : 'bg-current')} />}
      {label}
    </Badge>
  )
}

/** Configuración → Ollama (referencia de diseño, página 3). */
export function OllamaPage() {
  const { status, loaded, installed, hardware, installFraction } = useOllama()
  const active = useSettings((s) => s.activeModel)
  const modelSource = useSettings((s) => s.modelSource)
  const [logs, setLogs] = useState<string[] | null>(null)
  const st = status?.state
  const ramGB = hardware?.ramGB ?? 0
  const modelsGB = loaded.reduce((a, m) => a + m.sizeBytes, 0) / GB
  const freeGB = hardware?.freeRamGB ?? 0
  const systemGB = Math.max(0, ramGB - freeGB - modelsGB)

  if (!hasBackend) return <div className="mt-6 text-body text-fg-3">Disponible en la aplicación de escritorio.</div>

  return (
    <>
      <div className="mt-6 rounded-[10px] border border-line-subtle bg-bg-1 p-4">
        <div className="flex items-center gap-3">
          <span className={cn('grid size-10 place-items-center rounded-lg border', st === 'connected' ? 'border-ok/40 bg-ok-soft text-ok' : 'border-line bg-bg-2 text-fg-3')}>
            <Server className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-body text-fg-1">
              Servidor local <StatusBadge />
            </div>
            <div className="truncate font-mono text-small text-fg-3">
              {status?.host.replace(/^https?:\/\//, '')}
              {status?.version && ` · v${status.version}`}
              {status?.startedAt && st === 'connected' && ` · activo desde ${ago(status.startedAt).replace('hace ', 'hace ')}`}
              {status?.managed && ' · iniciado por ZHASKA'}
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            {status?.managed && (
              <Button size="sm" variant="ghost" onClick={async () => setLogs(await api('ollama.logs').catch(() => []))}>
                Ver registros
              </Button>
            )}
            {st === 'connected' && status?.managed && (
              <>
                <Button
                  size="sm"
                  icon={<RotateCw />}
                  onClick={async () => {
                    await useOllama.getState().stop()
                    await useOllama.getState().start()
                  }}
                >
                  Reiniciar
                </Button>
                <Button size="sm" variant="danger" icon={<Square />} onClick={() => void useOllama.getState().stop()}>
                  Detener
                </Button>
              </>
            )}
            {(st === 'stopped' || st === 'error') && (
              <Button size="sm" variant="primary" icon={<Play />} onClick={() => void useOllama.getState().start()}>
                Iniciar
              </Button>
            )}
            {st === 'not-installed' && (
              <Button
                size="sm"
                variant="primary"
                icon={<Download />}
                disabled={installFraction !== null || !!status?.installing}
                onClick={async () => {
                  const ok = await confirm({
                    title: 'Instalar Ollama',
                    description:
                      window.zhaska?.platform === 'win32'
                        ? 'Se descargará el instalador oficial desde ollama.com, se verificará su firma digital y se abrirá para que completes la instalación. Necesita conexión a Internet.'
                        : 'Se abrirá la página oficial de descarga de Ollama en el navegador. ZHASKA lo detectará automáticamente cuando esté instalado.',
                    confirmLabel: 'Continuar',
                  })
                  if (ok) void useOllama.getState().install()
                }}
              >
                {status?.installing === 'downloading' ? `Descargando ${Math.round((installFraction ?? 0) * 100)} %` : status?.installing === 'verifying' ? 'Verificando firma…' : status?.installing === 'installing' ? 'Instalando…' : 'Instalar Ollama'}
              </Button>
            )}
          </div>
        </div>
        {status?.error && <div className="mt-2 text-small text-err">{status.error}</div>}
        {st === 'connected' && status?.managed === false && (
          <div className="mt-2 text-tiny text-fg-3">Este servidor lo inició otra aplicación (o el propio Ollama). Para detenerlo, ciérralo desde su icono en la bandeja del sistema.</div>
        )}
        <div className="mt-4 grid grid-cols-4 overflow-hidden rounded-lg border border-line-subtle">
          {[
            ['Aceleración', hardware ? (hardware.accel === 'cuda' ? `CUDA · ${hardware.gpu}` : hardware.accel === 'metal' ? `Metal · ${hardware.gpu}` : 'Solo CPU') : '—'],
            ['Memoria', hardware ? (hardware.unified ? `${Math.round(ramGB)} GB unificada` : `${Math.round(hardware.vramGB ?? 0)} GB VRAM · ${Math.round(ramGB)} GB RAM`) : '—'],
            ['Disco libre', hardware?.diskFreeGB != null ? `${Math.round(hardware.diskFreeGB)} GB` : '—'],
            ['Carpeta de modelos', hardware?.modelsDir.replace(/^\/Users\/[^/]+|^C:\\Users\\[^\\]+/i, '~') ?? '—'],
          ].map(([k, v]) => (
            <div key={k} className="border-r border-line-subtle bg-bg-0 px-3 py-2.5 last:border-0">
              <div className="text-tiny text-fg-3">{k}</div>
              <div className="mt-0.5 truncate text-small text-fg-1" title={v}>
                {v}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-6 flex items-baseline justify-between">
        <div className="text-body font-medium text-fg-1">En memoria ahora</div>
        <div className="font-mono text-small text-fg-3">
          {modelsGB.toLocaleString('es-ES', { maximumFractionDigits: 1 })} de {Math.round(ramGB)} GB
        </div>
      </div>
      <div className="mt-3 rounded-[10px] border border-line-subtle bg-bg-1 p-4">
        <div className="flex h-2 overflow-hidden rounded-full bg-bg-4">
          <div className="bg-accent" style={{ width: `${(modelsGB / ramGB) * 100 || 0}%` }} />
          <div className="bg-fg-3/60" style={{ width: `${(systemGB / ramGB) * 100 || 0}%` }} />
        </div>
        <div className="mt-2 flex gap-4 text-small text-fg-3">
          <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-accent" />Modelos {modelsGB.toLocaleString('es-ES', { maximumFractionDigits: 1 })} GB</span>
          <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-fg-3/60" />Sistema y apps {systemGB.toLocaleString('es-ES', { maximumFractionDigits: 1 })} GB</span>
          <span className="flex items-center gap-1.5"><span className="size-2 rounded-full border border-fg-3" />Libre {freeGB.toLocaleString('es-ES', { maximumFractionDigits: 1 })} GB</span>
        </div>
        {loaded.length === 0 && <div className="mt-3 text-small text-fg-3">Ningún modelo cargado. Se cargan al usarlos y se liberan tras unos minutos sin uso.</div>}
        {loaded.map((m) => (
          <div key={m.name} className="mt-3 flex items-center gap-2.5 rounded-lg border border-line-subtle bg-bg-0 px-3 py-2.5 text-small">
            <span className="size-1.5 rounded-full bg-ok" />
            <span className="font-mono text-body text-fg-1">{m.name}</span>
            <span className="font-mono text-fg-3">
              {formatBytes(m.sizeBytes)} · {m.sizeBytes ? Math.round((m.vramBytes / m.sizeBytes) * 100) : 0} % GPU{m.contextLength ? ` · contexto ${Math.round(m.contextLength / 1024)}K` : ''}
            </span>
            <span className="ml-auto text-fg-3">{until(m.expiresAt)}</span>
            <Button size="sm" variant="ghost" onClick={() => void useOllama.getState().unload(m.name)}>
              Liberar
            </Button>
          </div>
        ))}
      </div>

      <div className="mt-6 overflow-hidden rounded-[10px] border border-line-subtle">
        <div className="flex items-center gap-4 bg-bg-1 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-body text-fg-1">Origen de las descargas</div>
            <div className="mt-0.5 text-small text-fg-3">
              Automático: primero el servidor de Ollama y, si tu red no lo alcanza, la misma versión oficial de Google desde Hugging Face, preparada para conservar herramientas y razonamiento.
            </div>
          </div>
          <Select value={modelSource} onChange={(e) => useSettings.getState().set('modelSource', e.target.value as typeof modelSource)} className="w-48">
            <option value="auto">Automático</option>
            <option value="ollama">Solo Ollama</option>
            <option value="huggingface">Hugging Face</option>
          </Select>
        </div>
      </div>

      <div className="mt-6 flex items-center justify-between">
        <div className="text-body font-medium text-fg-1">Modelos instalados</div>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" icon={<RefreshCw />} onClick={() => void useOllama.getState().refreshModels()}>
            Actualizar
          </Button>
          <Button size="sm" variant="primary" icon={<Download />} onClick={() => useUI.getState().openDialog('models')}>
            Descargar modelo
          </Button>
        </div>
      </div>
      <div className="mt-3 overflow-hidden rounded-[10px] border border-line-subtle">
        <div className="grid grid-cols-[1fr_80px_90px_70px_110px_110px] gap-3 bg-bg-0 px-4 py-2 text-tiny text-fg-3">
          <span>Modelo</span>
          <span>Tamaño</span>
          <span>Cuantización</span>
          <span>Contexto</span>
          <span>Estado</span>
          <span />
        </div>
        {installed.length === 0 && <div className="bg-bg-1 px-4 py-4 text-small text-fg-3">{st === 'connected' ? 'No hay modelos descargados.' : 'Conecta Ollama para ver los modelos.'}</div>}
        {installed.map((m) => (
          <div key={m.name} className="grid grid-cols-[1fr_80px_90px_70px_110px_110px] items-center gap-3 border-t border-line-subtle bg-bg-1 px-4 py-2.5 text-small">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate font-mono text-body text-fg-1">{m.name}</span>
              {m.name === active && <Badge tone="agent">Predeterminado</Badge>}
            </span>
            <span className="font-mono text-fg-2">{formatBytes(m.sizeBytes)}</span>
            <span className="font-mono text-fg-2">{m.quantization ?? '—'}</span>
            <span className="font-mono text-fg-2">{m.contextLength ? `${Math.round(m.contextLength / 1024)}K` : '—'}</span>
            <span className="text-fg-3">{loaded.some((l) => l.name === m.name) ? 'En memoria' : ago(m.modifiedAt)}</span>
            <span className="flex justify-end gap-1">
              <Button size="sm" variant="ghost" onClick={() => void useOllama.getState().load(m.name)}>
                Cargar
              </Button>
              <button
                type="button"
                aria-label="Más acciones"
                className="grid size-7 place-items-center rounded-md text-fg-3 hover:bg-bg-3 hover:text-fg-1"
                onClick={(e) =>
                  openMenuAt(
                    e.currentTarget,
                    [
                      { id: 'def', label: 'Usar como predeterminado', icon: <Star />, onSelect: () => useSettings.getState().set('activeModel', m.name) },
                      { id: 'bench', label: 'Banco de pruebas', icon: <FlaskConical />, onSelect: () => useUI.getState().openDialog('settings', 'models') },
                      { id: 's', separator: true },
                      {
                        id: 'del',
                        label: 'Eliminar del equipo',
                        icon: <Trash />,
                        danger: true,
                        onSelect: async () => {
                          if (await confirm({ title: `Eliminar ${m.name}`, description: `Se liberarán ${formatBytes(m.sizeBytes)} de disco. Podrás volver a descargarlo.`, confirmLabel: 'Eliminar', danger: true })) void useOllama.getState().remove(m.name)
                        },
                      },
                    ],
                    'end',
                  )
                }
              >
                <Ellipsis className="size-4" />
              </button>
            </span>
          </div>
        ))}
      </div>

      <Dialog open={logs !== null} onClose={() => setLogs(null)} title="Registros de Ollama" width={760}>
        <pre className="selectable max-h-[60vh] overflow-auto bg-bg-terminal p-4 font-mono text-tiny leading-[1.6] text-fg-2">{logs?.length ? logs.join('\n') : 'Sin registros todavía.'}</pre>
      </Dialog>
    </>
  )
}

/** Configuración → Modelos: modelo activo y banco de pruebas. */
export function ModelsPage() {
  const s = useSettings()
  const installed = useOllama((x) => x.installed)
  const bench = useOllama((x) => x.bench)
  const benches = useOllama((x) => x.benches)
  const connected = useOllama((x) => x.status?.state === 'connected')
  const options = [...new Set([...installed.map((m) => m.name), ...GEMMA4_VARIANTS.filter((v) => v.quant === 'QAT').map((v) => v.tag)])]
  const visionModels = installed.filter((m) => m.capabilities.includes('vision')).map((m) => m.name)
  const activeVision = installed.find((m) => m.name === s.activeModel)?.capabilities.includes('vision') ?? false
  const [target, setTarget] = useState(s.activeModel)
  useEffect(() => setTarget(s.activeModel), [s.activeModel])

  return (
    <>
      <div className="mt-6 overflow-hidden rounded-[10px] border border-line-subtle">
        <RowLike label="Modelo del agente" description="Se usa en las conversaciones nuevas y en el agente.">
          <Select value={s.activeModel} onChange={(e) => s.set('activeModel', e.target.value)} className="w-64">
            {options.map((name) => (
              <option key={name} value={name}>
                {name}
                {isInstalled(installed, name) ? '' : ' (sin descargar)'}
              </option>
            ))}
          </Select>
        </RowLike>
        <RowLike
          label="Imágenes adjuntas"
          description={
            activeVision
              ? `${s.activeModel} ve las imágenes directamente. El modelo auxiliar solo se usa con modelos sin visión.`
              : 'El modelo activo no ve imágenes: un modelo local con visión las describe y la descripción se le pasa marcada como tal.'
          }
        >
          <Select value={s.visionModel} onChange={(e) => s.set('visionModel', e.target.value)} className="w-64">
            <option value="auto">Automático (primer modelo con visión)</option>
            {visionModels.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
            <option value="off">Ninguno (solo texto por OCR)</option>
          </Select>
        </RowLike>
      </div>
      <div className="mt-3">
        <Button icon={<Download />} onClick={() => useUI.getState().openDialog('models')}>
          Descargar Gemma 4
        </Button>
      </div>

      <div className="mt-8 text-body font-medium text-fg-1">Banco de pruebas</div>
      <div className="mt-0.5 text-small text-fg-3">
        Mide en este equipo la carga, la velocidad de generación, el procesamiento de contexto y la fiabilidad de las llamadas a herramientas. Tarda 1–3 minutos y usa la GPU al máximo mientras dura.
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Select value={target} onChange={(e) => setTarget(e.target.value)} className="w-64">
          {installed.map((m) => (
            <option key={m.name} value={m.name}>
              {m.name}
            </option>
          ))}
        </Select>
        {bench ? (
          <>
            <Button variant="danger" onClick={() => void useOllama.getState().cancelBench()}>
              Cancelar
            </Button>
            <span className="flex items-center gap-2 text-small text-fg-2">
              <Spinner size={12} tone="accent" />
              {bench.step} ({bench.index}/{bench.total})
            </span>
          </>
        ) : (
          <Button variant="primary" icon={<FlaskConical />} disabled={!connected || !isInstalled(installed, target)} onClick={() => void useOllama.getState().runBench(target)}>
            Ejecutar
          </Button>
        )}
      </div>
      {benches.length > 0 && <BenchTable records={benches} />}
    </>
  )
}

function RowLike({ label, description, children }: { label: string; description?: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-4 border-b border-line-subtle bg-bg-1 px-4 py-3 last:border-0">
      <div className="min-w-0 flex-1">
        <div className="text-body text-fg-1">{label}</div>
        {description && <div className="mt-0.5 text-small text-fg-3">{description}</div>}
      </div>
      {children}
    </div>
  )
}

const fmt = (n: number, d = 1) => n.toLocaleString('es-ES', { maximumFractionDigits: d })
const ratio = (r: { valid: number; total: number } | null) => (r ? `${r.valid}/${r.total}` : '—')

export function benchMarkdown(records: BenchRecord[]): string {
  const head = '| Fecha | Modelo | Hardware | GPU % | Carga | Generación | Prefill | Herram. nativas | Herram. JSON |\n|---|---|---|---|---|---|---|---|---|'
  const rows = records.map((r) => {
    const hw = r.hardware.unified ? `${r.hardware.gpu} ${Math.round(r.hardware.ramGB)} GB unif.` : `${r.hardware.gpu ?? 'CPU'} ${r.hardware.vramGB ? `${Math.round(r.hardware.vramGB)} GB` : ''} · ${Math.round(r.hardware.ramGB)} GB RAM`
    const x = r.result
    return `| ${new Date(r.createdAt).toLocaleDateString('es-ES')} | \`${x.model}\` (ctx ${Math.round(x.numCtx / 1024)}K) | ${hw} | ${x.gpuPercent ?? '—'} | ${fmt(x.loadMs / 1000)} s | ${fmt(x.genTokensPerSec)} tok/s | ${fmt(x.prefillTokensPerSec, 0)} tok/s | ${ratio(x.toolsNative)} | ${ratio(x.toolsJson)} |`
  })
  return `${head}\n${rows.join('\n')}`
}

function BenchTable({ records }: { records: BenchRecord[] }) {
  return (
    <div className="mt-4 overflow-hidden rounded-[10px] border border-line-subtle">
      <div className="grid grid-cols-[1.4fr_60px_70px_90px_90px_80px_80px] gap-2 bg-bg-0 px-4 py-2 text-tiny text-fg-3">
        <span>Modelo</span>
        <span>GPU</span>
        <span>Carga</span>
        <span>Generación</span>
        <span>Prefill</span>
        <span>Nativas</span>
        <span>JSON</span>
      </div>
      {records.slice(0, 10).map((r) => (
        <div key={r.id} className="grid grid-cols-[1.4fr_60px_70px_90px_90px_80px_80px] items-center gap-2 border-t border-line-subtle bg-bg-1 px-4 py-2.5 font-mono text-small text-fg-2">
          <span className="min-w-0">
            <span className="block truncate text-fg-1">{r.result.model}</span>
            <span className="block font-sans text-tiny text-fg-3">{new Date(r.createdAt).toLocaleString('es-ES')}</span>
          </span>
          <span>{r.result.gpuPercent ?? '—'} %</span>
          <span>{fmt(r.result.loadMs / 1000)} s</span>
          <span className="text-fg-1">{fmt(r.result.genTokensPerSec)} t/s</span>
          <span>{fmt(r.result.prefillTokensPerSec, 0)} t/s</span>
          <span>{ratio(r.result.toolsNative)}</span>
          <span>{ratio(r.result.toolsJson)}</span>
        </div>
      ))}
      <div className="flex justify-end border-t border-line-subtle bg-bg-0 px-4 py-2">
        <Button
          size="sm"
          variant="ghost"
          icon={<Copy />}
          onClick={() => {
            void navigator.clipboard?.writeText(benchMarkdown(records))
            toast({ tone: 'success', title: 'Resultados copiados como Markdown' })
          }}
        >
          Copiar como Markdown
        </Button>
      </div>
    </div>
  )
}
