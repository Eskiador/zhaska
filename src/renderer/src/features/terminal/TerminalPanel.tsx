import { useEffect, useMemo, useRef, type ReactNode, type RefObject } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { CircleAlert, CircleCheck, PanelBottomClose, Plus, RotateCw, Sparkles, SquareTerminal, X } from 'lucide-react'
import { parseDiagnostics } from '@shared/agent/diagnostics'
import { IconButton } from '@renderer/components/ui/Button'
import { cn } from '@renderer/lib/cn'
import { api, hasBackend } from '@renderer/lib/api'
import { useActivity } from '@renderer/stores/activity'
import { useLayout } from '@renderer/stores/layout'
import { useSettings } from '@renderer/stores/settings'
import { terminalIO, useTerminals } from '@renderer/stores/terminals'
import { useWorkspace } from '@renderer/stores/workspace'

export const XTERM_THEME = {
  background: '#08080A',
  foreground: '#DADAE2',
  cursor: '#EDEDF2',
  cursorAccent: '#08080A',
  selectionBackground: '#8E87FF55',
  black: '#141418',
  red: '#FF6B70',
  green: '#4ADE9A',
  yellow: '#F2C063',
  blue: '#6CB6FF',
  magenta: '#B7A8FF',
  cyan: '#6ED7D3',
  white: '#DADAE2',
  brightBlack: '#85858F',
  brightRed: '#FF8F93',
  brightGreen: '#7BE8B5',
  brightYellow: '#F5D08A',
  brightBlue: '#93C9FF',
  brightMagenta: '#CFC4FF',
  brightCyan: '#93E3E0',
  brightWhite: '#EDEDF2',
}

const FONT = '"Geist Mono Variable", "Cascadia Code", Consolas, monospace'

/** Terminal (referencia: Terminal · Problemas · Agente). Las terminales del usuario son shells reales (node-pty). */
export function TerminalPanel() {
  const project = useWorkspace((s) => s.project)
  const { sessions, active, setActive, create, kill } = useTerminals()
  const diagnostics = useDiagnostics()

  useEffect(() => {
    useTerminals.getState().init()
    if (project && !project.demo) void useTerminals.getState().load(project.id)
    else useTerminals.getState().reset()
  }, [project?.id, project?.demo]) // eslint-disable-line react-hooks/exhaustive-deps

  const canShell = hasBackend && !!project && !project.demo
  const openNew = () => project && void create(project.id)

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden bg-bg-terminal">
      <div className="flex h-9 shrink-0 items-stretch border-b border-line-subtle">
        <div className="flex min-w-0 flex-1 overflow-x-auto [scrollbar-width:none]">
          {sessions.length === 0 && <TabBtn active={active === 'new'} onClick={() => (canShell ? openNew() : setActive('new'))} icon={<SquareTerminal />} label="Terminal" />}
          {sessions.map((s) => (
            <TabBtn key={s.id} active={active === s.id} onClick={() => setActive(s.id)} icon={<SquareTerminal className={s.alive ? '' : 'opacity-40'} />} label={s.title} onClose={() => void kill(s.id)} />
          ))}
          <TabBtn active={active === 'problems'} onClick={() => setActive('problems')} icon={diagnostics.length ? <CircleAlert className="text-err" /> : <CircleCheck />} label="Problemas" badge={diagnostics.length || undefined} />
          <TabBtn active={active === 'agent'} onClick={() => setActive('agent')} icon={<Sparkles className="text-agent" />} label="Agente" />
        </div>
        <div className="flex shrink-0 items-center gap-0.5 px-1.5">
          {active === 'agent' && <span className="mr-1.5 flex items-center gap-1.5 rounded-full bg-agent-soft px-2 py-0.5 text-tiny text-agent">● controlado por el agente</span>}
          <IconButton size="sm" label="Nueva terminal" icon={<Plus />} disabled={!canShell} onClick={openNew} />
          <IconButton size="sm" label="Ocultar terminal" icon={<PanelBottomClose />} onClick={() => useLayout.getState().toggle('terminal')} />
        </div>
      </div>
      {/* overflow-hidden: sin esto, el ajuste de xterm y la barra de desplazamiento se realimentan en bucle */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {active === 'new' && (
          <div className="grid h-full place-items-center text-small text-fg-3">
            {canShell ? (
              <button type="button" onClick={openNew} className="flex items-center gap-2 rounded-md border border-line px-3 py-1.5 text-fg-2 hover:bg-bg-2 hover:text-fg-1">
                <SquareTerminal className="size-4" /> Abrir una terminal en el proyecto
              </button>
            ) : (
              'Abre un proyecto real para usar la terminal.'
            )}
          </div>
        )}
        {sessions.map((s) => (
          <ShellView key={s.id} id={s.id} visible={active === s.id} alive={s.alive} onRestart={() => void kill(s.id).then(openNew)} />
        ))}
        <AgentView visible={active === 'agent'} />
        {active === 'problems' && <ProblemsView items={diagnostics} />}
      </div>
    </section>
  )
}

function TabBtn({ active, onClick, icon, label, onClose, badge }: { active: boolean; onClick: () => void; icon: ReactNode; label: string; onClose?: () => void; badge?: number }) {
  return (
    <div
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn('group flex shrink-0 cursor-default items-center gap-1.5 border-r border-line-subtle pr-2 pl-3 text-small [&_svg]:size-3.5', active ? 'bg-bg-1 text-fg-1 shadow-[inset_0_-1px_0_var(--color-accent)]' : 'text-fg-3 hover:text-fg-2')}
    >
      {icon}
      <span className="whitespace-nowrap">{label}</span>
      {badge !== undefined && <span className="rounded-full bg-err-soft px-1.5 font-mono text-micro text-err">{badge}</span>}
      {onClose && (
        <button
          type="button"
          aria-label={`Cerrar ${label}`}
          onClick={(e) => {
            e.stopPropagation()
            onClose()
          }}
          className="grid size-4 place-items-center rounded-sm text-fg-3 opacity-0 group-hover:opacity-100 hover:bg-bg-3 hover:text-fg-1"
        >
          <X className="!size-3" />
        </button>
      )}
    </div>
  )
}

function useXterm(host: RefObject<HTMLDivElement | null>, opts: { interactive: boolean; onReady: (t: Terminal) => () => void; onResize?: (cols: number, rows: number) => void }) {
  const fontSize = useSettings((s) => s.terminalFontSize)
  useEffect(() => {
    const term = new Terminal({ theme: XTERM_THEME, fontFamily: FONT, fontSize, lineHeight: 1.45, cursorBlink: opts.interactive, cursorStyle: 'bar', disableStdin: !opts.interactive, scrollback: 10_000 })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host.current!)
    let last = ''
    const ro = new ResizeObserver(() => {
      if (!host.current || host.current.offsetWidth === 0 || host.current.offsetHeight === 0) return
      fit.fit()
      const key = `${term.cols}x${term.rows}`
      if (key !== last) {
        last = key
        opts.onResize?.(term.cols, term.rows)
      }
    })
    ro.observe(host.current!)
    const dispose = opts.onReady(term)
    return () => {
      dispose()
      ro.disconnect()
      term.dispose()
    }
  }, [fontSize]) // eslint-disable-line react-hooks/exhaustive-deps
}

function ShellView({ id, visible, alive, onRestart }: { id: string; visible: boolean; alive: boolean; onRestart: () => void }) {
  const host = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  useXterm(host, {
    interactive: true,
    onResize: (cols, rows) => void api('terminal.resize', { id, cols, rows }).catch(() => {}),
    onReady: (term) => {
      termRef.current = term
      const detach = terminalIO.attach(id, (d) => term.write(d))
      const input = term.onData((d) => void api('terminal.write', { id, data: d }).catch(() => {}))
      return () => {
        detach()
        input.dispose()
      }
    },
  })
  useEffect(() => {
    if (visible) setTimeout(() => termRef.current?.focus(), 0)
  }, [visible])
  return (
    <div className={cn('absolute inset-0', !visible && 'invisible')}>
      <div ref={host} data-terminal={id} className="absolute inset-0 overflow-hidden py-1.5 pl-3" />
      {!alive && visible && (
        <button type="button" onClick={onRestart} className="absolute right-3 bottom-3 flex items-center gap-1.5 rounded-md border border-line bg-bg-2 px-2.5 py-1 text-small text-fg-1 hover:bg-bg-3">
          <RotateCw className="size-3.5" /> Reiniciar terminal
        </button>
      )}
    </div>
  )
}

const DIM = '\x1b[38;2;133;133;143m'
const AGENT = '\x1b[38;2;142;135;255m'
const RESET = '\x1b[0m'

/** Salida de los comandos del agente (eventos step.output reales). Solo lectura. */
function AgentView({ visible }: { visible: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  useXterm(host, {
    interactive: false,
    onReady: (term) => {
      let written = new Map<string, number>()
      let task: string | undefined
      const sync = () => {
        const s = useActivity.getState().state
        if (s.taskId !== task || s.status === 'idle') {
          term.write('\x1bc')
          written = new Map()
          task = s.taskId
          term.writeln(`${DIM}Salida de los comandos que ejecuta el agente. Solo lectura.${RESET}`)
          if (useWorkspace.getState().project?.demo) term.writeln(`${DIM}(Demostración)${RESET}`)
          term.writeln('')
        }
        for (const st of s.steps) {
          const done = written.get(st.id) ?? 0
          if (st.output.length > done) {
            for (const line of st.output.slice(done)) {
              if (line.startsWith('> ')) term.writeln(`${AGENT}❯${RESET} ${line.slice(2)}`)
              else if (/error|fail/i.test(line)) term.writeln(`\x1b[38;2;255;107;112m${line}${RESET}`)
              else term.writeln(line)
            }
            written.set(st.id, st.output.length)
          }
          if (st.id === s.approval?.stepId && ['execute_command', 'install_dependencies', 'run_tests', 'inspect_errors'].includes(s.approval.tool) && !written.has(`${st.id}:wait`)) {
            term.writeln(`\x1b[38;2;242;192;99m⏸ En espera de aprobación:${RESET} ${s.approval.command}`)
            written.set(`${st.id}:wait`, 1)
          }
        }
      }
      sync()
      return useActivity.subscribe(sync)
    },
  })
  return <div ref={host} className={cn('absolute inset-0 overflow-hidden py-1.5 pl-3', !visible && 'invisible')} />
}

/** Errores de la última comprobación o prueba fallida del agente. */
function useDiagnostics() {
  const steps = useActivity((s) => s.state.steps)
  return useMemo(() => {
    const checks = steps.filter((st) => st.tool === 'inspect_errors' || st.tool === 'run_tests')
    const last = checks[checks.length - 1]
    if (!last || last.status !== 'failed') return []
    return parseDiagnostics(last.output.join('\n'))
  }, [steps])
}

function ProblemsView({ items }: { items: { file: string; line: number; message: string }[] }) {
  if (!items.length)
    return (
      <div className="grid h-full place-items-center text-small text-fg-3">
        <span className="flex items-center gap-2">
          <CircleCheck className="size-4 text-ok" /> Sin problemas en la última comprobación del agente.
        </span>
      </div>
    )
  return (
    <div className="h-full overflow-y-auto py-1">
      {items.map((d, i) => (
        <button
          key={i}
          type="button"
          onClick={() => void useWorkspace.getState().openAt(d.file.replace(/\\/g, '/').replace(/^\.\//, ''), d.line)}
          className="flex w-full items-start gap-2 px-3 py-1.5 text-left text-small hover:bg-bg-2"
        >
          <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-err" />
          <span className="min-w-0 flex-1 text-fg-1">{d.message}</span>
          <span className="shrink-0 font-mono text-tiny text-fg-3">
            {d.file}:{d.line}
          </span>
        </button>
      ))}
    </div>
  )
}
