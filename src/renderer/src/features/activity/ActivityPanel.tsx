import { useEffect, useMemo, useRef, useState } from 'react'
import { Activity, ChevronRight, CircleAlert, Clock, Copy, Ellipsis, FileText, Pause, PanelRightClose, Play, ScrollText, ShieldExclamationPoint, Square } from 'lucide-react'
import type { AgentEvent } from '@shared/agent/events'
import { Button, IconButton } from '@renderer/components/ui/Button'
import { EmptyState, Spinner } from '@renderer/components/ui/primitives'
import { Dialog, openMenuAt } from '@renderer/components/ui/overlays'
import { cn } from '@renderer/lib/cn'
import { formatDuration } from '@renderer/lib/format'
import { useActivity } from '@renderer/stores/activity'
import { useLayout } from '@renderer/stores/layout'
import { toast } from '@renderer/stores/ui'
import { useWorkspace } from '@renderer/stores/workspace'
import { TOOL_ICON } from '@renderer/features/chat/toolMeta'
import { groupSteps, taskStats, type StepGroup } from './groups'
import { useHighlight } from './highlight'
import type { ActivityState } from './reducer'
import type { PlanItem } from '@shared/agent/events'

const COMMAND_TOOLS = new Set(['execute_command', 'install_dependencies', 'run_tests', 'inspect_errors'])
const APPROVAL_TITLE: Record<string, string> = {
  execute_command: 'Ejecutar un comando',
  install_dependencies: 'Instalar dependencias',
  run_tests: 'Ejecutar las pruebas',
  inspect_errors: 'Comprobar errores',
  create_file: 'Crear un archivo',
  edit_file: 'Modificar un archivo',
  write_file: 'Reescribir un archivo',
  delete_file: 'Eliminar un archivo',
  read_file: 'Leer un archivo',
}

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    const t = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(t)
  }, [active])
  return now
}

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

/** Panel de actividad (referencia de diseño, páginas 1 y 11). Todo procede de eventos reales del agente. */
export function ActivityPanel() {
  const state = useActivity((s) => s.state)
  const replaying = useActivity((s) => s.replaying)
  const { replay, resolveApproval, stop, pause, resume } = useActivity.getState()
  const isDemo = useWorkspace((s) => s.project?.demo ?? false)
  const real = useActivity((s) => !!s.realTaskId)
  const running = state.status === 'running'
  const now = useNow(running)
  const elapsed = state.startedAt ? (state.endedAt ?? now) - state.startedAt : 0
  const groups = useMemo(() => groupSteps(state), [state])
  const [log, setLog] = useState(false)

  const badge = running ? (state.paused ? ['En pausa', 'text-warn bg-warn-soft'] : ['En curso', 'text-accent bg-accent-soft']) : state.status === 'completed' ? ['Completada', 'text-ok bg-ok-soft'] : state.status === 'failed' ? ['Falló', 'text-err bg-err-soft'] : state.status === 'cancelled' ? ['Detenida', 'text-fg-2 bg-bg-3'] : null

  return (
    <section className="flex h-full min-w-0 flex-col bg-bg-activity" aria-label="Actividad del agente">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line-subtle px-3.5">
        <span className="text-body font-medium">Actividad</span>
        {badge && (
          <span className={cn('flex items-center gap-1.5 rounded-full px-2 py-0.5 text-tiny', badge[1])}>
            {running && !state.paused && <span className="size-1.5 animate-pulse rounded-full bg-current" />}
            {badge[0]}
          </span>
        )}
        {state.startedAt && <span className="ml-auto font-mono text-tiny text-fg-3">{clock(elapsed)}</span>}
        <div className={cn('flex gap-0.5', !state.startedAt && 'ml-auto')}>
          <IconButton
            label="Más opciones"
            icon={<Ellipsis />}
            onClick={(e) =>
              openMenuAt(
                e.currentTarget,
                [
                  { id: 'log', label: 'Registro completo', icon: <ScrollText />, onSelect: () => setLog(true) },
                  ...(isDemo ? [{ id: 'demo', label: replaying ? 'Reproduciendo…' : 'Reproducir demostración', icon: <Play />, onSelect: replay }] : []),
                  ...(running ? [{ id: 'stop', label: 'Detener tarea', icon: <Square />, danger: true, onSelect: stop }] : []),
                  { id: 's', separator: true },
                  { id: 'hide', label: 'Ocultar panel', icon: <PanelRightClose />, onSelect: () => useLayout.getState().toggle('activity') },
                ],
                'end',
              )
            }
          />
        </div>
      </div>

      {state.status === 'idle' ? (
        <EmptyState className="flex-1" icon={<Activity />} title="Sin actividad" description="Cuando el agente trabaje, aquí verás cada archivo que lee, cada cambio y cada comando, en tiempo real.">
          {isDemo && (
            <Button size="sm" icon={<Play />} onClick={replay}>
              Ver demostración
            </Button>
          )}
        </EmptyState>
      ) : (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-3 pb-4" aria-live="polite">
            <CurrentTask state={state} groups={groups} />
            {state.approval && (
              <div className="mt-3 animate-pop-in rounded-[10px] border border-warn/45 bg-warn-soft p-3">
                <div className="flex items-center gap-2 text-body font-medium text-warn">
                  <ShieldExclamationPoint className="size-4" />
                  {APPROVAL_TITLE[state.approval.tool] ?? 'Permiso para continuar'}
                </div>
                <div className="selectable mt-2 rounded-md border border-line bg-bg-0 px-2.5 py-1.5 font-mono text-small text-fg-1">
                  {COMMAND_TOOLS.has(state.approval.tool) && <span className="text-fg-3">$ </span>}
                  {state.approval.command}
                </div>
                <div className="mt-1.5 text-small text-fg-2">{state.approval.detail}</div>
                <div className="mt-2.5 flex gap-1.5">
                  <Button size="sm" variant="primary" onClick={() => resolveApproval('allow_once')}>
                    Permitir
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => resolveApproval('deny')}>
                    Denegar
                  </Button>
                  {state.approval.canAlways ? (
                    <Button size="sm" variant="ghost" className="ml-auto" onClick={() => resolveApproval('allow_always')} tooltip="Crea una regla para este proyecto (revocable en Configuración → Agente y permisos)">
                      Siempre aquí
                    </Button>
                  ) : (
                    <span className="ml-auto self-center text-tiny text-fg-3" title="Las acciones peligrosas, los borrados, los archivos protegidos y lo de fuera del proyecto se preguntan cada vez">
                      Se pregunta cada vez
                    </span>
                  )}
                </div>
              </div>
            )}

            <div className="mt-3 flex flex-col">
              {groups.map((g, i) => (
                <GroupCard key={g.key} g={g} now={now} last={i === groups.length - 1 && pendingPlan(state).length === 0} />
              ))}
              {pendingPlan(state).map((item, i, arr) => (
                <PendingCard key={item.id} item={item} last={i === arr.length - 1} />
              ))}
            </div>

            {state.status !== 'running' && state.summary && (
              <div className={cn('mt-3 rounded-[10px] border px-3 py-2.5 text-small', state.status === 'completed' ? 'border-ok/30 bg-ok-soft text-ok' : state.status === 'failed' ? 'border-err/30 bg-err-soft text-err' : 'border-line bg-bg-2 text-fg-2')}>
                {state.summary}
              </div>
            )}
          </div>

          <div className="shrink-0 border-t border-line-subtle px-3 py-2.5">
            {real && running && (
              <div className="mb-2 flex gap-2">
                <Button className="flex-1" icon={state.paused ? <Play /> : <Pause />} onClick={state.paused ? resume : pause}>
                  {state.paused ? 'Reanudar agente' : 'Pausar agente'}
                </Button>
                <Button variant="ghost" icon={<ScrollText />} onClick={() => setLog(true)}>
                  Registro completo
                </Button>
              </div>
            )}
            {!(real && running) && (
              <Button variant="ghost" size="sm" className="mb-1.5 w-full" icon={<ScrollText />} onClick={() => setLog(true)}>
                Registro completo
              </Button>
            )}
            <div className="flex flex-wrap gap-x-3.5 gap-y-1 font-mono text-[11px] whitespace-nowrap text-fg-3">
              <span>
                acciones <b className="font-medium text-fg-2">{state.steps.length}</b>
              </span>
              <span>
                tokens <b className="font-medium text-fg-2">{(state.tokens / 1000).toLocaleString('es-ES', { maximumFractionDigits: 1 })}K</b>
              </span>
              <span title="Ocupación de la ventana de contexto">
                ctx <b className="font-medium text-fg-2">{Math.round(state.contextUsed * 100)} %</b>
              </span>
              {state.tokensPerSec && <span className="ml-auto">{state.tokensPerSec.toLocaleString('es-ES')} tok/s</span>}
            </div>
          </div>
        </>
      )}
      <EventLog open={log} onClose={() => setLog(false)} />
    </section>
  )
}

/** Elementos del plan declarados por el agente que todavía no han empezado (referencia: «En cola»). */
function pendingPlan(state: ActivityState): PlanItem[] {
  if (state.status !== 'running') return []
  const started = new Set(state.steps.map((s) => s.planItemId).filter(Boolean))
  return state.plan.filter((p) => !started.has(p.id) && p.tool).slice(0, 6)
}

function CurrentTask({ state, groups }: { state: ActivityState; groups: StepGroup[] }) {
  const stats = taskStats(state)
  const current = [...groups].reverse().find((g) => g.status === 'running')
  const title =
    state.status !== 'running'
      ? state.status === 'completed'
        ? 'Tarea completada'
        : state.status === 'failed'
          ? 'La tarea no terminó'
          : 'Tarea detenida'
      : state.paused
        ? 'En pausa'
        : state.approval
          ? 'Esperando tu aprobación'
          : (current?.label ?? (state.modelState === 'thinking' ? 'Razonando' : state.modelState === 'prompt' ? 'Procesando el contexto' : 'Decidiendo el siguiente paso'))
  return (
    <div className="rounded-[10px] border border-line-subtle bg-bg-1 p-3.5">
      <div className="flex items-center justify-between text-micro font-medium tracking-[0.06em] text-fg-3 uppercase">
        Tarea actual
        <span className="font-mono tracking-normal normal-case">{stats.actions} acciones</span>
      </div>
      <div className="mt-1 flex items-center gap-2 text-[15px] font-medium text-fg-1">
        {state.status === 'running' && !state.paused && !state.approval && <Spinner size={13} tone="agent" />}
        {title}
      </div>
      <div className="relative mt-3 h-1 overflow-hidden rounded-full bg-bg-4">
        {state.status === 'running' ? (
          <div className={cn('absolute inset-y-0 w-1/3 rounded-full bg-accent', !state.paused && 'animate-[sweep-bar_1.4s_ease-in-out_infinite]')} />
        ) : (
          <div className={cn('h-full rounded-full', state.status === 'completed' ? 'bg-ok' : state.status === 'failed' ? 'bg-err' : 'bg-fg-3')} style={{ width: '100%' }} />
        )}
      </div>
      <div className="mt-3 grid grid-cols-3 text-small">
        <Stat value={stats.read} label="leídos" />
        <Stat value={stats.changed} label="cambiados" />
        <div>
          <div className="font-mono text-body">
            <span className="text-ok">+{stats.additions}</span> <span className="text-err">−{stats.deletions}</span>
          </div>
          <div className="text-fg-3">líneas</div>
        </div>
      </div>
    </div>
  )
}

const Stat = ({ value, label }: { value: number; label: string }) => (
  <div>
    <div className="font-mono text-body text-fg-1">{value}</div>
    <div className="text-fg-3">{label}</div>
  </div>
)

function GroupCard({ g, now, last }: { g: StepGroup; now: number; last: boolean }) {
  const Icon = TOOL_ICON[g.steps[0]!.tool]
  const hasOutput = g.steps.some((s) => s.output.length > 0)
  const [open, setOpen] = useState(g.status === 'failed')
  const highlightN = useHighlight((s) => (s.stepId && g.steps.some((st) => st.id === s.stepId) ? s.n : 0))
  const ref = useRef<HTMLDivElement>(null)
  const [flash, setFlash] = useState(false)
  const done = g.status === 'completed'
  const running = g.status === 'running'

  useEffect(() => {
    if (g.status === 'failed') setOpen(true)
  }, [g.status])
  useEffect(() => {
    if (!highlightN) return
    ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    setFlash(true)
    const t = setTimeout(() => setFlash(false), 1200)
    return () => clearTimeout(t)
  }, [highlightN])

  const duration = (g.endedAt ?? now) - g.startedAt
  const command = g.steps.length === 1 && COMMAND_TOOLS.has(g.steps[0]!.tool) ? g.steps[0]!.target : undefined
  const subtitle = command
    ? undefined
    : g.kind === 'plan'
      ? g.steps[0]!.summary ?? g.steps[0]!.target
      : g.files.length
        ? `${g.files.length > 1 ? `${g.files.length} archivos` : g.files[0]}${g.steps.length > 1 && g.files.length === 1 ? ` · ${g.steps.length} veces` : ''}`
        : g.steps[g.steps.length - 1]!.summary ?? g.steps[0]!.target
  const errors = g.steps.filter((s) => s.status === 'failed' && s.error)
  const cancelled = g.status === 'cancelled'

  return (
    <div ref={ref} data-group={g.key} data-steps={g.steps.map((s) => s.id).join(',')} className="relative flex animate-step-in gap-3">
      {/* Línea de tiempo */}
      <div className="flex flex-col items-center">
        <span
          className={cn(
            'relative mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border [&_svg]:size-4',
            running ? 'border-accent/50 bg-accent-soft text-accent animate-pulse-agent' : g.status === 'failed' ? 'border-err/40 bg-err-soft text-err' : cancelled ? 'border-line bg-bg-1 text-fg-disabled' : 'border-line bg-bg-1 text-fg-2',
          )}
        >
          <Icon />
          {done && <span className="absolute -right-1 -bottom-1 grid size-3.5 place-items-center rounded-full bg-ok text-[9px] font-bold text-bg-0">✓</span>}
        </span>
        {!last && <span className="my-1 w-px flex-1 bg-line-subtle" />}
      </div>
      <div className={cn('min-w-0 flex-1 pb-4 transition-colors', flash && 'rounded-md bg-agent-soft')}>
        <div className="flex items-start gap-2">
          <div className={cn('min-w-0 flex-1 text-body', running ? 'text-fg-1' : cancelled ? 'text-fg-3 line-through' : done ? 'text-fg-1' : 'text-fg-1')}>{cancelled ? `${g.label}` : g.label}</div>
          <span className={cn('shrink-0 font-mono text-[11px]', running ? 'text-accent' : 'text-fg-3')}>{running ? clock(duration) : formatDuration(duration)}</span>
        </div>
        {cancelled && <div className="text-small text-fg-3">Denegado o detenido</div>}
        {subtitle && !cancelled && <div className="truncate text-small text-fg-3">{subtitle}</div>}
        {(g.additions > 0 || g.deletions > 0) && (
          <div className="font-mono text-small">
            {g.additions > 0 && <span className="text-ok">+{g.additions}</span>} {g.deletions > 0 && <span className="text-err">−{g.deletions}</span>}
          </div>
        )}
        {command && (
          <div className="mt-1.5 inline-flex max-w-full items-center rounded-md border border-line bg-bg-1 px-2 py-0.5 font-mono text-small text-fg-1">
            <span className="mr-1.5 text-fg-3">$</span>
            <span className="truncate">{command}</span>
          </div>
        )}
        {g.files.length > 1 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {g.files.slice(0, 3).map((f) => (
              <span key={f} className="flex items-center gap-1 rounded-md border border-line bg-bg-1 px-1.5 py-px font-mono text-[11px] text-fg-2">
                <FileText className="size-3" />
                {f}
              </span>
            ))}
            {g.files.length > 3 && <span className="rounded-md border border-line bg-bg-1 px-1.5 py-px font-mono text-[11px] text-fg-3">+{g.files.length - 3}</span>}
          </div>
        )}
        {errors.length > 0 && (
          <div className="selectable mt-2 flex items-start gap-2 rounded-md border border-err/35 bg-err-soft px-2.5 py-1.5 font-mono text-[11px] text-err">
            <CircleAlert className="mt-px size-3.5 shrink-0" />
            <span className="break-words">{errors[errors.length - 1]!.error}</span>
          </div>
        )}
        {hasOutput && (
          <button type="button" onClick={() => setOpen(!open)} className="mt-1.5 flex items-center gap-1 text-small text-fg-3 hover:text-fg-1">
            <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
            {open ? 'Ocultar salida' : 'Ver salida'}
          </button>
        )}
        {open && hasOutput && (
          <div className="selectable mt-1.5 max-h-56 overflow-auto rounded-md border border-line bg-bg-terminal px-2 py-1.5 font-mono text-[11px] leading-[1.6] text-fg-3">
            {g.steps.flatMap((s) => s.output).map((l, i) => (
              <div key={i} className={cn('whitespace-pre', /error|fail|✗/i.test(l) && 'text-err', l.startsWith('> ') && 'text-fg-2')}>
                {l}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function PendingCard({ item, last }: { item: PlanItem; last: boolean }) {
  const Icon = item.tool ? TOOL_ICON[item.tool] : Clock
  return (
    <div className="flex gap-3 opacity-60">
      <div className="flex flex-col items-center">
        <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border border-dashed border-line-strong text-fg-3 [&_svg]:size-4">
          <Icon />
        </span>
        {!last && <span className="my-1 w-px flex-1 bg-line-subtle" />}
      </div>
      <div className="min-w-0 flex-1 pb-4">
        <div className="text-body text-fg-2">{item.title}</div>
        <div className="truncate text-small text-fg-3">En cola{item.target ? ` · ${item.target}` : ''}</div>
      </div>
    </div>
  )
}

/** Registro completo: todos los eventos guardados de la tarea, con su hora. */
function EventLog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const events = useActivity((s) => s.events)
  const start = events[0]?.ts ?? 0
  const describe = (e: AgentEvent): string => {
    switch (e.type) {
      case 'task.started':
        return `modelo ${e.model}`
      case 'plan.updated':
        return e.items.map((i) => i.title).join(' · ')
      case 'step.started':
        return `${e.tool} · ${e.title}${e.target ? ` · ${e.target}` : ''}`
      case 'step.output':
        return e.chunk
      case 'step.completed':
        return [e.summary, e.diff ? `+${e.diff.additions} −${e.diff.deletions}` : ''].filter(Boolean).join(' · ')
      case 'step.failed':
        return e.error
      case 'approval.requested':
        return `${e.tool} · ${e.command} · ${e.detail}`
      case 'approval.resolved':
        return e.decision === 'allow_once' ? 'permitido una vez' : e.decision === 'allow_always' ? 'permitido siempre en este proyecto' : 'denegado'
      case 'model.state':
        return `${e.state}${e.tokensPerSec ? ` · ${e.tokensPerSec} tok/s` : ''}`
      case 'metrics':
        return `${e.tokens} tokens · contexto ${Math.round(e.contextUsed * 100)} %`
      case 'task.completed':
        return e.summary
      case 'task.failed':
        return e.error
      case 'task.cancelled':
        return e.reason ?? ''
      default:
        return ''
    }
  }
  const lines = events.map((e) => `+${((e.ts - start) / 1000).toFixed(1).padStart(6)} s  ${e.type.padEnd(18)} ${describe(e)}`)
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Registro completo"
      icon={<ScrollText />}
      width={860}
      footer={
        <>
          <span className="mr-auto text-small text-fg-3">{events.length} eventos · cada fila es un evento real guardado del agente</span>
          <Button
            icon={<Copy />}
            onClick={() => {
              void navigator.clipboard?.writeText(lines.join('\n'))
              toast({ tone: 'success', title: 'Registro copiado' })
            }}
          >
            Copiar
          </Button>
        </>
      }
    >
      <pre className="selectable max-h-[60vh] overflow-auto bg-bg-terminal p-4 font-mono text-[11.5px] leading-[1.7] text-fg-2">{lines.join('\n') || 'Sin eventos.'}</pre>
    </Dialog>
  )
}
