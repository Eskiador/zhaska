import { useShallow } from 'zustand/react/shallow'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Activity, Boxes, Bot, Code, Columns3, CornerDownLeft, FolderOpen, FolderPlus, MessageSquare, PanelBottom, PanelLeft, PanelRight, Play, Rocket, Search, Settings, X } from 'lucide-react'
import { Dialog } from '@renderer/components/ui/overlays'
import { Kbd } from '@renderer/components/ui/primitives'
import { cn } from '@renderer/lib/cn'
import { MOD } from '@renderer/lib/platform'
import { FileIcon } from '@renderer/features/explorer/fileIcons'
import { closeProject, pickAndOpenFolder } from '@renderer/stores/projects'
import { useChat } from '@renderer/stores/chat'
import { api, hasBackend } from '@renderer/lib/api'
import { useActivity } from '@renderer/stores/activity'
import { useLayout } from '@renderer/stores/layout'
import { useUI } from '@renderer/stores/ui'
import { knownFiles, useWorkspace } from '@renderer/stores/workspace'

interface Cmd {
  id: string
  group: 'Archivos' | 'Conversaciones' | 'Vista' | 'Aplicación'
  label: string
  detail?: string
  icon: ReactNode
  shortcut?: string
  run: () => void
}

/** Puntuación difusa simple: subsecuencia con bonus por inicio de palabra y contigüidad. */
function score(q: string, text: string): number {
  if (!q) return 1
  const t = text.toLowerCase()
  let ti = 0
  let s = 0
  let streak = 0
  for (const ch of q.toLowerCase()) {
    const i = t.indexOf(ch, ti)
    if (i < 0) return 0
    streak = i === ti ? streak + 1 : 0
    s += 1 + streak * 2 + (i === 0 || /[\s/._-]/.test(t[i - 1]!) ? 3 : 0)
    ti = i + 1
  }
  return s - t.length * 0.01
}

export function CommandPalette() {
  const open = useUI((s) => s.dialog === 'palette')
  const close = useUI((s) => s.closeDialog)
  const known = useWorkspace(useShallow((s) => knownFiles(s.dirs)))
  const conversations = useChat((s) => s.conversations)
  const hasProject = useWorkspace((s) => !!s.project)
  const project = useWorkspace((s) => s.project)
  const [q, setQ] = useState('')
  // Con texto, se busca en TODO el proyecto (índice en main); sin texto, los archivos ya cargados en el explorador
  const [found, setFound] = useState<{ q: string; files: string[] } | null>(null)
  useEffect(() => {
    if (!open || !q.trim() || !hasBackend || !project || project.demo) return setFound(null)
    let alive = true
    const t = setTimeout(() => {
      void api('fs.findFiles', { projectId: project.id, query: q, limit: 40 })
        .then((r) => alive && setFound({ q, files: r.files }))
        .catch(() => alive && setFound(null))
    }, 60)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [q, open, project])
  const files = q && found ? found.files : known
  const [idx, setIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) {
      setQ('')
      setIdx(0)
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [open])

  const commands = useMemo<Cmd[]>(() => {
    const ui = useUI.getState()
    const layout = useLayout.getState()
    const view: Cmd[] = hasProject
      ? [
          { id: 'p-agent', group: 'Vista', label: 'Modo agente', detail: 'Chat y actividad, sin editor', icon: <Bot />, shortcut: `${MOD} 1`, run: () => layout.applyPreset('agent') },
          { id: 'p-ide', group: 'Vista', label: 'Modo IDE', detail: 'Editor y terminal protagonistas', icon: <Code />, shortcut: `${MOD} 2`, run: () => layout.applyPreset('ide') },
          { id: 'p-full', group: 'Vista', label: 'Vista completa', detail: 'Las cuatro zonas', icon: <Columns3 />, shortcut: `${MOD} 3`, run: () => layout.applyPreset('full') },
          { id: 't-side', group: 'Vista', label: 'Mostrar/ocultar barra lateral', icon: <PanelLeft />, shortcut: `${MOD} B`, run: () => layout.toggle('sidebar') },
          { id: 't-act', group: 'Vista', label: 'Mostrar/ocultar actividad', icon: <PanelRight />, shortcut: `${MOD} ⇧ I`, run: () => layout.toggle('activity') },
          { id: 't-term', group: 'Vista', label: 'Mostrar/ocultar terminal', icon: <PanelBottom />, shortcut: `${MOD} J`, run: () => layout.toggle('terminal') },
          { id: 'demo', group: 'Aplicación', label: 'Reproducir demostración de actividad', icon: <Play />, run: () => { layout.show('activity'); useActivity.getState().replay() } },
          { id: 'close', group: 'Aplicación', label: 'Cerrar proyecto', icon: <X />, run: closeProject },
        ]
      : []
    return [
      ...(q ? files : files.slice(0, 6)).map<Cmd>((f) => ({
        id: `f:${f}`,
        group: 'Archivos',
        label: f.split('/').pop()!,
        detail: f,
        icon: <FileIcon name={f} />,
        run: () => {
          layout.show('workbench')
          void useWorkspace.getState().openFile(f)
        },
      })),
      ...(q ? conversations : conversations.slice(0, 5)).map<Cmd>((c) => ({
        id: `c:${c.id}`,
        group: 'Conversaciones',
        label: c.title,
        icon: <MessageSquare />,
        run: () => void useChat.getState().select(c.id),
      })),
      ...view,
      { id: 'newp', group: 'Aplicación', label: 'Nuevo proyecto', icon: <FolderPlus />, shortcut: `⇧${MOD} N`, run: () => ui.openDialog('newProject') },
      ...(hasBackend ? [{ id: 'openf', group: 'Aplicación' as const, label: 'Abrir carpeta…', icon: <FolderOpen />, shortcut: `${MOD} O`, run: () => void pickAndOpenFolder() }] : []),
      { id: 'settings', group: 'Aplicación', label: 'Configuración', icon: <Settings />, shortcut: `${MOD} ,`, run: () => ui.openDialog('settings') },
      { id: 'models', group: 'Aplicación', label: 'Gestionar modelos', icon: <Boxes />, run: () => ui.openDialog('models') },
      { id: 'onb', group: 'Aplicación', label: 'Asistente de primera ejecución', icon: <Rocket />, run: () => ui.setOnboarding(true) },
      { id: 'activity', group: 'Aplicación', label: 'Ir al panel de actividad', icon: <Activity />, run: () => layout.show('activity') },
    ]
  }, [files, conversations, hasProject, q])

  const results = useMemo(() => {
    const scored = commands.map((c) => ({ c, s: Math.max(score(q, c.label), score(q, c.detail ?? '') * 0.8) })).filter((r) => r.s > 0)
    if (q) scored.sort((a, b) => b.s - a.s)
    return scored.slice(0, 40).map((r) => r.c)
  }, [commands, q])

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${idx}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [idx])

  const run = (c?: Cmd) => {
    if (!c) return
    close()
    c.run()
  }

  let lastGroup = ''
  return (
    <Dialog open={open} onClose={close} width={620} bare>
      <div className="flex h-11 items-center gap-2.5 border-b border-line px-3.5">
        <Search className="size-4 text-fg-3" />
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setIdx(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setIdx((i) => Math.min(i + 1, results.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setIdx((i) => Math.max(i - 1, 0))
            } else if (e.key === 'Enter') run(results[idx])
          }}
          placeholder="Buscar archivos y comandos…"
          className="flex-1 bg-transparent text-body text-fg-1 outline-none placeholder:text-fg-3"
        />
        <Kbd>Esc</Kbd>
      </div>
      <div ref={listRef} className="max-h-[52vh] overflow-y-auto p-1.5">
        {results.length === 0 && <div className="px-3 py-8 text-center text-small text-fg-3">Sin resultados para «{q}»</div>}
        {results.map((c, i) => {
          const header = c.group !== lastGroup ? c.group : null
          lastGroup = c.group
          return (
            <div key={c.id}>
              {header && <div className="px-2.5 pt-2 pb-1 text-micro font-semibold tracking-[0.07em] text-fg-3 uppercase">{header}</div>}
              <button
                type="button"
                data-idx={i}
                onMouseMove={() => setIdx(i)}
                onClick={() => run(c)}
                className={cn('flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left [&>svg]:size-3.5', i === idx ? 'bg-bg-3 text-fg-1' : 'text-fg-2')}
              >
                <span className="text-fg-3 [&_svg]:size-3.5">{c.icon}</span>
                <span className="truncate text-[12.5px]">{c.label}</span>
                {c.detail && <span className="truncate font-mono text-micro text-fg-3">{c.detail}</span>}
                <span className="ml-auto flex shrink-0 items-center gap-2">
                  {c.shortcut && <span className="font-mono text-micro text-fg-3">{c.shortcut}</span>}
                  {i === idx && <CornerDownLeft className="size-3 text-fg-3" />}
                </span>
              </button>
            </div>
          )
        })}
      </div>
    </Dialog>
  )
}
