import { useMemo, useState, type ReactNode } from 'react'
import { Clock, Code2, Files, FolderOpen, FolderPlus, MessageSquare, PanelLeft, Pencil, Plus, Settings, SquarePen, Trash, X } from 'lucide-react'
import { IconButton } from '@renderer/components/ui/Button'
import { Kbd, Segmented } from '@renderer/components/ui/primitives'
import { AssistantSidebar } from '@renderer/features/assistant/AssistantView'
import { openContextMenu } from '@renderer/components/ui/overlays'
import { confirm } from '@renderer/components/ui/confirm'
import { LogoMark } from '@renderer/components/Logo'
import { cn } from '@renderer/lib/cn'
import { MOD, inElectron, isMac } from '@renderer/lib/platform'
import { hasBackend } from '@renderer/lib/api'
import { useChat, type ConversationItem } from '@renderer/stores/chat'
import { useLayout } from '@renderer/stores/layout'
import { forgetProject, openDemo, openProjectById, pickAndOpenFolder } from '@renderer/stores/projects'
import { useProjects } from '@renderer/stores/projects'
import { useSettings } from '@renderer/stores/settings'
import { isInstalled, useOllama } from '@renderer/stores/ollama'
import { useUI } from '@renderer/stores/ui'
import { useWorkspace } from '@renderer/stores/workspace'

const AVATAR_COLORS = ['#8E87FF', '#4ADE9A', '#F2C063', '#6CB6FF', '#FF8FA3', '#6ED7D3']
const avatarColor = (s: string) => AVATAR_COLORS[[...s].reduce((a, c) => a + c.charCodeAt(0), 0) % AVATAR_COLORS.length]!

export function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  const min = Math.round(diff / 60_000)
  if (min < 1) return 'ahora'
  if (min < 60) return `${min} min`
  const h = Math.round(min / 60)
  if (h < 24) return `${h} h`
  const d = Math.round(h / 24)
  if (d === 1) return 'ayer'
  if (d < 7) return `${d} d`
  return new Date(ts).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })
}

function groupByDate(items: ConversationItem[]) {
  const startToday = new Date().setHours(0, 0, 0, 0)
  const groups: [string, ConversationItem[]][] = [
    ['Hoy', []],
    ['Ayer', []],
    ['Últimos 7 días', []],
    ['Anteriores', []],
  ]
  for (const c of items) {
    const idx = c.updatedAt >= startToday ? 0 : c.updatedAt >= startToday - 86_400_000 ? 1 : c.updatedAt >= startToday - 7 * 86_400_000 ? 2 : 3
    groups[idx]![1].push(c)
  }
  return groups.filter(([, list]) => list.length > 0)
}

export function Sidebar() {
  const project = useWorkspace((s) => s.project)
  const conversations = useChat((s) => s.conversations)
  const activeId = useChat((s) => s.activeId)
  const recents = useProjects((s) => s.recents)
  const explorerOpen = useLayout((s) => !s.collapsed.explorer)
  const openDialog = useUI((s) => s.openDialog)
  const view = useUI((s) => s.view)
  const toCode = () => useUI.getState().setView('code')
  const groups = useMemo(() => groupByDate(conversations), [conversations])
  const [renaming, setRenaming] = useState<string | null>(null)

  return (
    <aside className="flex h-full min-w-0 flex-col bg-bg-sidebar">
      <div className={cn('drag flex h-10 shrink-0 items-center justify-end px-2', inElectron && isMac && 'pl-[78px]')}>
        <IconButton className="no-drag" label="Ocultar barra lateral" shortcut={`${MOD} B`} icon={<PanelLeft />} onClick={() => useLayout.getState().toggle('sidebar')} />
      </div>

      <div className="flex items-center gap-2.5 px-4 pt-1 pb-4">
        <LogoMark size={30} />
        <div className="min-w-0">
          <div className="text-[15px] font-semibold tracking-[0.06em]">ZHASKA</div>
          <div className="text-small text-fg-3">IA local · Ollama</div>
        </div>
      </div>

      <div className="px-2.5 pb-3" title={`Cambiar entre Chat y Código (${MOD} ⇧ M)`}>
        <Segmented
          full
          value={view}
          onChange={(v) => useUI.getState().setView(v)}
          options={[
            { value: 'assistant', label: 'Chat', icon: <MessageSquare /> },
            { value: 'code', label: 'Código', icon: <Code2 /> },
          ]}
        />
      </div>

      {view === 'assistant' ? (
        <AssistantSidebar />
      ) : (
        <>
          <nav className="flex flex-col gap-0.5 px-2.5">
            <NavRow
              primary
              icon={<SquarePen />}
              label="Nueva conversación"
              shortcut={`${MOD} N`}
              disabled={!project}
              onClick={() => {
                toCode()
                if (project) void useChat.getState().newConversation(project.id)
              }}
            />
            <NavRow icon={<FolderPlus />} label="Nuevo proyecto" shortcut={`⇧${MOD} N`} onClick={() => openDialog('newProject')} />
            <NavRow icon={<Clock />} label="Historial" shortcut={`${MOD} K`} onClick={() => openDialog('palette')} />
            <NavRow icon={<Files />} label="Explorador de archivos" shortcut={`⇧${MOD} E`} active={!!project && explorerOpen} disabled={!project} onClick={() => useLayout.getState().toggle('explorer')} />
          </nav>

          <div className="mt-4 min-h-0 flex-1 overflow-y-auto pb-2">
            <SectionTitle
              action={<IconButton size="sm" label="Abrir carpeta" icon={<Plus />} onClick={() => (hasBackend ? void pickAndOpenFolder() : openDialog('newProject'))} />}
            >
              Proyectos recientes
            </SectionTitle>
            <div className="flex flex-col gap-px px-2.5">
              {recents.slice(0, 6).map((p) => {
                const active = project?.id === p.id
                return (
                  <button
                    key={p.id}
                    type="button"
                    title={p.rootPath}
                    onClick={() => {
                      toCode()
                      if (!active) void openProjectById(p.id)
                    }}
                    onContextMenu={(e) =>
                      openContextMenu(e, [
                        { id: 'open', label: 'Abrir', icon: <FolderOpen />, onSelect: () => void openProjectById(p.id) },
                        { id: 'forget', label: 'Quitar de recientes', icon: <X />, onSelect: () => void forgetProject(p.id) },
                      ])
                    }
                    className={cn('group flex h-[30px] items-center gap-2.5 rounded-md px-2 text-left text-body', active ? 'bg-bg-3 text-fg-1' : 'text-fg-2 hover:bg-bg-2 hover:text-fg-1', !p.exists && 'opacity-60')}
                  >
                    <span className="grid size-[18px] shrink-0 place-items-center rounded-[5px] bg-bg-3 text-micro font-semibold" style={{ color: avatarColor(p.name) }}>
                      {p.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="flex-1 truncate">{p.name}</span>
                    <span className={cn('text-tiny', p.exists ? 'text-fg-3' : 'text-err')}>{!p.exists ? 'no encontrada' : active ? 'abierto' : relativeTime(p.lastOpenedAt)}</span>
                  </button>
                )
              })}
              {recents.length === 0 && (
                <button type="button" onClick={openDemo} className="flex h-[30px] items-center gap-2.5 rounded-md px-2 text-left text-body text-fg-3 hover:bg-bg-2 hover:text-fg-1">
                  <span className="grid size-[18px] place-items-center rounded-[5px] bg-bg-3 text-micro font-semibold text-warn">D</span>
                  Proyecto de demostración
                </button>
              )}
            </div>

            {project && (
              <>
                <SectionTitle className="mt-4">Conversaciones</SectionTitle>
                {groups.length === 0 && <div className="px-4 py-1 text-small text-fg-3">Todavía no hay conversaciones en este proyecto.</div>}
                {groups.map(([label, list]) => (
                  <div key={label} className="mb-1.5">
                    <div className="px-4 pt-1 pb-1 text-small text-fg-3">{label}</div>
                    <div className="flex flex-col gap-px px-2.5">
                      {list.map((c) =>
                        renaming === c.id ? (
                          <InlineInput
                            key={c.id}
                            initial={c.title}
                            onDone={(v) => {
                              setRenaming(null)
                              if (v !== null) void useChat.getState().rename(c.id, v)
                            }}
                          />
                        ) : (
                          <button
                            key={c.id}
                            type="button"
                            onClick={() => {
                              toCode()
                              void useChat.getState().select(c.id)
                            }}
                            onDoubleClick={() => setRenaming(c.id)}
                            onContextMenu={(e) =>
                              openContextMenu(e, [
                                { id: 'rename', label: 'Renombrar', icon: <Pencil />, onSelect: () => setRenaming(c.id) },
                                { id: 'sep', separator: true },
                                {
                                  id: 'delete',
                                  label: 'Eliminar conversación',
                                  icon: <Trash />,
                                  danger: true,
                                  onSelect: async () => {
                                    const ok = await confirm({ title: 'Eliminar conversación', description: `Se eliminará «${c.title}» y todos sus mensajes. No se puede deshacer.`, confirmLabel: 'Eliminar', danger: true })
                                    if (ok) void useChat.getState().remove(c.id)
                                  },
                                },
                              ])
                            }
                            className={cn('flex h-[30px] items-center gap-2 rounded-md px-2 text-left text-body', c.id === activeId ? 'bg-bg-3 text-fg-1' : 'text-fg-2 hover:bg-bg-2 hover:text-fg-1')}
                          >
                            <span className="flex-1 truncate">{c.title}</span>
                            {c.id === activeId && <span className="size-1.5 shrink-0 rounded-full bg-accent" />}
                          </button>
                        ),
                      )}
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>

        </>
      )}

      <div className="px-2.5 pb-2.5">
        <ModelCard />
        <NavRow icon={<Settings />} label="Configuración" shortcut={`${MOD} ,`} onClick={() => openDialog('settings')} />
      </div>
    </aside>
  )
}

function NavRow({ icon, label, shortcut, onClick, active, disabled, primary }: { icon: ReactNode; label: string; shortcut?: string; onClick: () => void; active?: boolean; disabled?: boolean; primary?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex h-[30px] items-center gap-2.5 rounded-md px-2.5 text-left text-body [&>svg]:size-4 [&>svg]:shrink-0',
        primary ? 'mb-1 h-9 border border-line bg-bg-2 text-fg-1 hover:bg-bg-3' : 'text-fg-2 hover:bg-bg-2 hover:text-fg-1',
        active && 'bg-bg-3 text-fg-1',
        disabled && 'pointer-events-none opacity-40',
      )}
    >
      {icon}
      <span className="flex-1 truncate">{label}</span>
      {shortcut && <Kbd className="border-line-subtle">{shortcut}</Kbd>}
    </button>
  )
}

function SectionTitle({ children, action, className }: { children: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex h-7 items-center justify-between px-4 text-micro font-medium tracking-[0.06em] text-fg-3 uppercase', className)}>
      <span>{children}</span>
      {action}
    </div>
  )
}

/** Campo de texto en línea (renombrar). Enter confirma, Escape cancela. */
export function InlineInput({ initial, onDone, className }: { initial: string; onDone: (value: string | null) => void; className?: string }) {
  const [value, setValue] = useState(initial)
  return (
    <input
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => {
        const dot = initial.lastIndexOf('.')
        e.target.setSelectionRange(0, dot > 0 ? dot : initial.length)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onDone(value)
        if (e.key === 'Escape') onDone(null)
        e.stopPropagation()
      }}
      onBlur={() => onDone(value === initial ? null : value)}
      className={cn('h-[28px] w-full rounded-md border border-accent bg-bg-0 px-2 text-body text-fg-1 outline-none', className)}
    />
  )
}

/** Tarjeta del modelo activo: en memoria, % en GPU y cuándo se libera (datos de /api/ps). */
function ModelCard() {
  const model = useSettings((s) => s.activeModel)
  const status = useOllama((s) => s.status?.state)
  const loaded = useOllama((s) => s.loaded.find((m) => m.name === model))
  const installed = useOllama((s) => isInstalled(s.installed, model))
  const pull = useOllama((s) => s.pulls[model])
  const ramGB = useOllama((s) => s.hardware?.ramGB ?? 0)
  const unified = useOllama((s) => s.hardware?.unified ?? false)
  const gpuPct = loaded?.sizeBytes ? Math.round((loaded.vramBytes / loaded.sizeBytes) * 100) : 0
  // Con GPU dedicada, si parte del modelo va al procesador la velocidad cae a una fracción (medido: 12B en 8 GB, ~70 %)
  const spills = !!loaded && !unified && gpuPct < 90
  const sizeGB = loaded ? loaded.sizeBytes / 1024 ** 3 : 0
  const minutes = loaded?.expiresAt ? Math.max(0, Math.round((loaded.expiresAt - Date.now()) / 60000)) : null
  const downloading = pull && !['done', 'error', 'cancelled'].includes(pull.phase)
  const pct = downloading && pull.total ? (pull.completed / pull.total) * 100 : loaded && ramGB ? (sizeGB / ramGB) * 100 : 0
  const line =
    status !== 'connected'
      ? 'Ollama no está conectado'
      : downloading
        ? `Descargando · ${Math.round(pct)} %`
        : loaded
          ? spills
            ? `${gpuPct} % en GPU · parte en el procesador, más lento`
            : `En memoria · ${gpuPct} % GPU${minutes !== null ? ` · libera en ${minutes} min` : ''}`
          : installed
            ? 'En disco · se carga al usarlo'
            : 'Sin descargar'
  return (
    <button
      type="button"
      onClick={() => useUI.getState().openDialog(installed ? 'settings' : 'models', 'ollama')}
      title={spills ? `Solo el ${gpuPct} % del modelo cabe en la tarjeta gráfica; el resto lo ejecuta el procesador y responde varias veces más lento. Es lo normal con Gemma 4 12B y 8 GB: va más despacio, pero resuelve mucho mejor las tareas largas. Para preguntas rápidas puedes cambiar a Gemma 4 E4B, que cabe entero.` : undefined}
      className="mb-1.5 w-full rounded-lg border border-line-subtle bg-bg-2 px-3 py-2.5 text-left hover:border-line"
    >
      <div className="flex items-center gap-2 text-small">
        <span className={cn('size-1.5 rounded-full', loaded ? 'bg-ok' : installed && status === 'connected' ? 'bg-fg-3' : 'bg-fg-disabled')} />
        <span className="truncate font-mono text-tiny text-fg-1">{model.replace(/-it-qat$/, '')}</span>
        {loaded && ramGB > 0 && (
          <span className="ml-auto shrink-0 font-mono text-tiny text-fg-3">
            {sizeGB.toLocaleString('es-ES', { maximumFractionDigits: 1 })} / {Math.round(ramGB)} GB
          </span>
        )}
      </div>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-bg-4">
        <div className={cn('h-full rounded-full', downloading ? 'bg-accent' : 'bg-accent/70')} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <div className={cn('mt-1.5 truncate text-tiny', spills ? 'text-warn' : 'text-fg-3')}>{line}</div>
    </button>
  )
}
