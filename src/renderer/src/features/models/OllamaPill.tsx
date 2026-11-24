import { CircleAlert, Download, Play } from 'lucide-react'
import { Spinner } from '@renderer/components/ui/primitives'
import { cn } from '@renderer/lib/cn'
import { hasBackend } from '@renderer/lib/api'
import { useChat } from '@renderer/stores/chat'
import { useOllama } from '@renderer/stores/ollama'
import { useUI } from '@renderer/stores/ui'

/** Indicador de conexión con Ollama (referencia: conectado · conectando · cargando modelo · detenido · error). */
export function OllamaPill() {
  const status = useOllama((s) => s.status)
  const loadingModel = useChat((s) => Object.values(s.live).find((l) => l.state === 'loading')?.model)
  const open = () => useUI.getState().openDialog('settings', 'ollama')
  const base = 'no-drag flex h-7 items-center gap-2 rounded-full border px-3 text-small'

  if (!hasBackend) return <span className={cn(base, 'border-line-subtle text-fg-3')}>Vista de navegador</span>
  const st = status?.state ?? 'checking'
  const port = status ? `:${new URL(status.host).port || '11434'}` : ''

  if (loadingModel)
    return (
      <button type="button" onClick={open} className={cn(base, 'border-accent/40 bg-accent-soft text-fg-1')}>
        <Spinner size={11} tone="accent" />
        <span className="font-mono text-tiny">{loadingModel}</span> cargando
      </button>
    )
  if (st === 'connected')
    return (
      <button type="button" onClick={open} className={cn(base, 'border-line-subtle bg-bg-1 text-fg-2 hover:border-line')}>
        <span className="size-1.5 rounded-full bg-ok shadow-[0_0_0_3px_rgb(74_222_154/0.15)]" />
        Ollama conectado <span className="font-mono text-tiny text-fg-3">{port}</span>
      </button>
    )
  if (st === 'checking' || st === 'starting')
    return (
      <span className={cn(base, 'border-line-subtle text-fg-2')}>
        <Spinner size={11} tone="muted" /> {st === 'starting' ? 'Iniciando Ollama…' : 'Conectando…'}
      </span>
    )
  if (st === 'stopped')
    return (
      <span className={cn(base, 'border-line-subtle text-fg-2')}>
        <span className="size-1.5 rounded-full border border-fg-3" /> Ollama detenido
        <button type="button" onClick={() => void useOllama.getState().start()} className="flex items-center gap-1 text-accent hover:underline">
          <Play className="size-3" /> Iniciar
        </button>
      </span>
    )
  if (st === 'not-installed')
    return (
      <button type="button" onClick={open} className={cn(base, 'border-warn/40 bg-warn-soft text-warn')}>
        <Download className="size-3.5" /> Instalar Ollama
      </button>
    )
  return (
    <span className={cn(base, 'border-err/40 bg-err-soft text-err')}>
      <CircleAlert className="size-3.5" /> Sin respuesta
      <button type="button" onClick={() => void useOllama.getState().start()} className="text-fg-1 hover:underline">
        Reintentar
      </button>
    </span>
  )
}
