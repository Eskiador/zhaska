import { CircleAlert, Download, Play, Sparkles } from 'lucide-react'
import { Button } from '@renderer/components/ui/Button'
import { MarkdownView } from './Markdown'
import { useOllama } from '@renderer/stores/ollama'
import { useUI } from '@renderer/stores/ui'
import type { LiveReply } from '@renderer/stores/chat'
import { Spinner, StatusIcon } from '@renderer/components/ui/primitives'
import { cn } from '@renderer/lib/cn'
import { useActivity } from '@renderer/stores/activity'
import { useLayout } from '@renderer/stores/layout'
import { useHighlight } from '@renderer/features/activity/highlight'
import type { ChatMessage, ToolChipRef } from '@renderer/demo/conversations'
import { AttachmentCard } from './AttachmentCard'
import { toMeta, useAttachments } from '@renderer/stores/attachments'
import { ChangesCard } from './ChangesCard'
import { CodeBlock } from './CodeBlock'
import { RichText } from './RichText'
import { TOOL_ICON } from './toolMeta'
import { usePreview } from './preview'

const time = (ts: number) => new Date(ts).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })

export function Message({ m }: { m: ChatMessage }) {
  const preview = usePreview()
  // Estado guardado de cada adjunto (miniatura, páginas, OCR…) si ya se cargó
  const rows = useAttachments((s) => s.rows)
  if (m.role === 'user') {
    const atts = m.attachments?.map((a) => (rows[a.id] ? toMeta(rows[a.id]!) : a))
    return (
      <div className="animate-step-in">
        <div className="mb-1.5 flex items-center gap-2 text-small text-fg-3">
          <span className="grid size-[18px] place-items-center rounded-[5px] bg-bg-4 text-micro font-semibold text-fg-2">TÚ</span>
          <span className="font-medium text-fg-2">Tú</span>· {time(m.ts)}
        </div>
        <div className="selectable rounded-lg border border-line bg-bg-2 px-3.5 py-2.5 leading-[1.6] text-fg-1">
          {m.blocks.map((b, i) => (b.kind === 'text' ? <RichText key={i} text={b.text} /> : null))}
          {atts && atts.length > 0 && (
            <div className="mt-2.5 flex flex-wrap gap-2">
              {atts.map((a) => (
                <AttachmentCard key={a.id} a={a} compact onOpen={() => preview(a)} />
              ))}
            </div>
          )}
        </div>
      </div>
    )
  }
  return <AssistantMessage m={m} />
}

function AssistantMessage({ m }: { m: ChatMessage }) {
  const live = useActivity((s) => !!m.taskId && s.state.taskId === m.taskId && s.state.status === 'running')
  const modelState = useActivity((s) => s.state.modelState)
  const taskStatus = useActivity((s) => (m.taskId && s.state.taskId === m.taskId ? s.state.status : undefined))
  const summary = useActivity((s) => s.state.summary)

  return (
    <div className="animate-step-in">
      <div className="mb-1.5 flex items-center gap-2 text-small text-fg-3">
        <span className="grid size-[18px] place-items-center rounded-[5px] bg-agent-soft text-agent">
          <Sparkles className="size-3" />
        </span>
        <span className="font-medium text-fg-2">ZHASKA</span>
        {m.model && <span className="font-mono text-tiny">· {m.model}</span>}
        <span>· {time(m.ts)}</span>
      </div>
      <div className={cn('selectable border-l-2 pl-3 leading-[1.65] text-fg-1 transition-colors duration-300', live ? 'border-agent' : 'border-transparent')}>
        {m.blocks.map((b, i) => {
          if (b.kind === 'text')
            return m.taskId ? (
              <p key={i} className="mb-2">
                <RichText text={b.text} />
              </p>
            ) : (
              <MarkdownView key={i} text={b.text} />
            )
          if (b.kind === 'notice') return <div key={i} className="mt-2 text-small text-fg-3">{b.text}</div>
          if (b.kind === 'error') return <ErrorBlock key={i} code={b.code} message={b.message} />
          if (b.kind === 'code') return <CodeBlock key={i} code={b.code} lang={b.lang} path={b.path} />
          if (b.kind === 'tools')
            return (
              <div key={i} className="my-2 flex flex-wrap gap-1.5">
                {b.chips.map((c) => (
                  <ToolChip key={c.stepId} chip={c} taskId={b.taskId} />
                ))}
              </div>
            )
          return <ChangesCard key={i} changes={b.changes} taskId={b.taskId} />
        })}
        {live && (
          <div className="mt-2 flex items-center gap-2 text-small text-fg-2">
            <Spinner size={12} />
            {modelState === 'thinking' && 'Razonando…'}
            {modelState === 'generating' && 'Generando…'}
            {modelState === 'prompt' && 'Procesando el contexto…'}
            {modelState === 'waiting_approval' && 'Esperando tu aprobación en el panel de actividad'}
          </div>
        )}
        {!live && taskStatus === 'completed' && (
          <div className="mt-3 flex items-center gap-2 rounded-md border border-ok/30 bg-ok-soft px-3 py-2 text-small text-ok">
            <StatusIcon status="completed" />
            {summary}
          </div>
        )}
        {m.metrics && <MetricsLine model={m.model} metrics={m.metrics} />}
        {!live && taskStatus === 'cancelled' && (
          <div className="mt-3 rounded-md border border-line bg-bg-2 px-3 py-2 text-small text-fg-2">Tarea detenida. Los cambios ya aplicados siguen pendientes de revisión.</div>
        )}
      </div>
    </div>
  )
}

function ToolChip({ chip, taskId }: { chip: ToolChipRef; taskId?: string }) {
  const step = useActivity((s) => s.state.steps.find((st) => st.id === chip.stepId))
  const Icon = TOOL_ICON[chip.tool]
  const status = step?.status ?? (chip.ok === undefined ? 'pending' : chip.ok ? 'completed' : 'failed')
  return (
    <button
      type="button"
      onClick={async () => {
        useLayout.getState().show('activity')
        // Si el paso es de otra tarea, reconstruirla desde el registro antes de resaltarlo
        if (taskId && useActivity.getState().realTaskId !== taskId) await useActivity.getState().loadTask(taskId)
        setTimeout(() => useHighlight.getState().flash(chip.stepId), 50)
      }}
      className={cn(
        'flex h-6 items-center gap-1.5 rounded-md border px-2 text-small transition-colors',
        status === 'running' ? 'border-agent/40 bg-agent-soft text-fg-1' : 'border-line bg-bg-2 text-fg-2 hover:border-line-strong',
        status === 'failed' && 'border-err/30',
        status === 'pending' && 'opacity-50',
      )}
    >
      {status === 'running' || status === 'failed' || status === 'cancelled' ? <StatusIcon status={status} /> : <Icon className={cn('size-3.5', status === 'completed' && 'text-ok')} />}
      {/* El verbo en pasado («Leído») solo si salió bien: un paso denegado o fallido no puede parecer hecho */}
      <span>{status === 'running' && chip.tool === 'install_dependencies' ? 'Esperando' : status === 'cancelled' ? 'Denegado' : status === 'failed' ? 'Falló' : chip.verb}</span>
      <span className="font-mono text-tiny text-fg-1">{chip.target}</span>
    </button>
  )
}

const PHASE_LABEL: Record<LiveReply['state'], string> = {
  approval: 'Esperando tu aprobación en el panel de actividad',
  paused: 'Agente en pausa · reanúdalo desde el panel de actividad',
  loading: 'Cargando el modelo en memoria…',
  prompt: 'Procesando el contexto…',
  thinking: 'Razonando…',
  generating: 'Generando…',
}

/** Respuesta en curso (streaming). El estado procede del modelo real; el razonamiento no se muestra. */
export function LiveMessage({ reply }: { reply: LiveReply }) {
  return (
    <div className="animate-step-in">
      <div className="mb-1.5 flex items-center gap-2 text-small text-fg-3">
        <span className="grid size-[18px] animate-pulse-agent place-items-center rounded-[5px] bg-agent-soft text-agent">
          <Sparkles className="size-3" />
        </span>
        <span className="font-medium text-fg-2">ZHASKA</span>
        <span className="font-mono text-tiny">· {reply.model}</span>
      </div>
      <div className="border-l-2 border-agent pl-3">
        {reply.kind === 'agent' && <LiveChips />}
        {reply.text ? <MarkdownView text={reply.text} /> : null}
        {reply.kind === 'agent' && Object.keys(reply.changes).length > 0 && (
          <div className="mt-2 font-mono text-tiny text-fg-3">
            {Object.keys(reply.changes).length} archivo(s) modificado(s) hasta ahora · podrás revisarlos al terminar
          </div>
        )}
        {reply.state !== 'generating' || !reply.text || reply.kind === 'agent' ? (
          <div className="mt-1 flex items-center gap-2 text-small text-fg-2">
            <Spinner size={12} />
            {PHASE_LABEL[reply.state]}
          </div>
        ) : (
          <span className="ml-0.5 inline-block h-4 w-[2px] animate-caret bg-agent align-[-3px]" />
        )}
      </div>
    </div>
  )
}

/** Pasos reales de la tarea en curso (los mismos eventos que el panel de actividad). */
function LiveChips() {
  const steps = useActivity((s) => s.state.steps)
  const visible = steps.filter((s) => s.tool !== 'update_plan')
  if (!visible.length) return null
  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      {visible.map((s) => (
        <ToolChip key={s.id} chip={{ stepId: s.id, tool: s.tool, verb: s.title, target: (s.target ?? '').split('/').pop()!.slice(0, 48) }} />
      ))}
    </div>
  )
}

function MetricsLine({ model, metrics }: { model?: string; metrics: NonNullable<ChatMessage['metrics']> }) {
  const secs = (metrics.totalMs / 1000).toLocaleString('es-ES', { maximumFractionDigits: 1 })
  return (
    <div className="mt-2 flex flex-wrap gap-x-3 font-mono text-[11px] text-fg-3" title={`Contexto: ${metrics.promptTokens} tokens · respuesta: ${metrics.evalTokens} tokens${metrics.loadMs > 500 ? ` · carga del modelo: ${(metrics.loadMs / 1000).toFixed(1)} s` : ''}`}>
      {model && <span>{model}</span>}
      <span>{metrics.tokensPerSec.toLocaleString('es-ES', { maximumFractionDigits: 1 })} tok/s</span>
      <span>{secs} s</span>
      <span>{(metrics.promptTokens + metrics.evalTokens).toLocaleString('es-ES')} tokens</span>
    </div>
  )
}

export function ErrorBlock({ code, message }: { code: string; message: string }) {
  const start = useOllama((s) => s.start)
  return (
    <div className="mt-2 flex items-start gap-2.5 rounded-lg border border-err/35 bg-err-soft px-3 py-2.5 text-small">
      <CircleAlert className="mt-0.5 size-4 shrink-0 text-err" />
      <div className="min-w-0 flex-1">
        <div className="text-fg-1">{code === 'OLLAMA_UNAVAILABLE' ? 'Ollama no está en ejecución' : code === 'MODEL_NOT_FOUND' ? 'El modelo no está descargado' : 'El modelo devolvió un error'}</div>
        <div className="mt-0.5 break-words text-fg-2">{message}</div>
      </div>
      {code === 'OLLAMA_UNAVAILABLE' && (
        <Button size="sm" icon={<Play />} onClick={() => void start()}>
          Iniciar Ollama
        </Button>
      )}
      {code === 'MODEL_NOT_FOUND' && (
        <Button size="sm" icon={<Download />} onClick={() => useUI.getState().openDialog('models')}>
          Descargar modelo
        </Button>
      )}
    </div>
  )
}
