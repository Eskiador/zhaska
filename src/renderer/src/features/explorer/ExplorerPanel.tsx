import { useEffect, useState, type MouseEvent } from 'react'
import { AtSign, ChevronRight, Copy, ExternalLink, FilePlus, FileText, FolderPlus, GitCompare, Pencil, RefreshCw, Trash } from 'lucide-react'
import type { DirEntry } from '@shared/ipc/contract'
import { IconButton } from '@renderer/components/ui/Button'
import { Spinner } from '@renderer/components/ui/primitives'
import { openContextMenu } from '@renderer/components/ui/overlays'
import { confirm } from '@renderer/components/ui/confirm'
import { cn } from '@renderer/lib/cn'
import { api, errorMessage } from '@renderer/lib/api'
import { InlineInput } from '@renderer/features/sidebar/Sidebar'
import { isDirty, useWorkspace } from '@renderer/stores/workspace'
import { useChat } from '@renderer/stores/chat'
import { toast } from '@renderer/stores/ui'
import { FileIcon } from './fileIcons'

/** Explorador de archivos del proyecto (panel propio según la referencia de diseño). */
export function ExplorerPanel() {
  const project = useWorkspace((s) => s.project)
  const root = useWorkspace((s) => s.dirs[''])
  const { startCreate, loadDir } = useWorkspace.getState()

  return (
    <section className="flex h-full min-w-0 flex-col bg-bg-explorer" aria-label="Explorador">
      <div className="flex h-[38px] shrink-0 items-center gap-1 border-b border-line-subtle pr-1.5 pl-3">
        <span className="flex-1 text-micro font-medium tracking-[0.06em] text-fg-3 uppercase">Explorador</span>
        <IconButton size="sm" label="Nuevo archivo" icon={<FilePlus />} onClick={() => startCreate('', 'file')} />
        <IconButton size="sm" label="Nueva carpeta" icon={<FolderPlus />} onClick={() => startCreate('', 'dir')} />
        <IconButton
          size="sm"
          label="Actualizar"
          icon={<RefreshCw />}
          onClick={() => {
            const { dirs } = useWorkspace.getState()
            Object.keys(dirs).forEach((d) => void loadDir(d))
          }}
        />
      </div>
      <div
        className="min-h-0 flex-1 overflow-auto py-1.5"
        onContextMenu={(e) => {
          if (e.target !== e.currentTarget) return
          openContextMenu(e, [
            { id: 'nf', label: 'Nuevo archivo', icon: <FilePlus />, onSelect: () => startCreate('', 'file') },
            { id: 'nd', label: 'Nueva carpeta', icon: <FolderPlus />, onSelect: () => startCreate('', 'dir') },
          ])
        }}
      >
        {project && <div className="truncate px-3 pb-1 text-small font-medium text-fg-2" title={project.rootPath}>{project.name}</div>}
        {!root ? (
          <div className="grid place-items-center py-6">
            <Spinner tone="muted" />
          </div>
        ) : (
          <div role="tree" className="px-1.5 text-body">
            <Children parent="" entries={root} depth={0} />
          </div>
        )}
      </div>
    </section>
  )
}

/** Carpetas enormes (miles de archivos): se pintan por tandas para que el explorador siga ágil (Fase 11). */
const PAGE = 500

function Children({ parent, entries, depth }: { parent: string; entries: DirEntry[]; depth: number }) {
  const creating = useWorkspace((s) => (s.creating?.parent === parent ? s.creating : null))
  const [shown, setShown] = useState(PAGE)
  const rest = entries.length - shown
  return (
    <>
      {creating && (
        <div className="flex h-6 items-center gap-1.5" style={{ paddingLeft: 6 + depth * 12 + 16 }}>
          <FileIcon name={creating.kind === 'dir' ? 'carpeta' : 'nuevo'} dir={creating.kind === 'dir'} />
          <InlineInput
            initial=""
            className="h-[22px] text-small"
            onDone={(v) => {
              if (v && v.trim()) void useWorkspace.getState().createEntry(parent, v, creating.kind)
              else useWorkspace.getState().cancelPending()
            }}
          />
        </div>
      )}
      {(rest > 0 ? entries.slice(0, shown) : entries).map((e) => (
        <Row key={e.rel} entry={e} depth={depth} />
      ))}
      {rest > 0 && (
        <div className="flex h-6 items-center gap-2 text-small text-fg-3" style={{ paddingLeft: 6 + depth * 12 + 16 }}>
          <span>{rest.toLocaleString('es-ES')} más</span>
          <button type="button" className="text-accent hover:underline" onClick={() => setShown((n) => n + PAGE)}>
            Mostrar {Math.min(PAGE, rest)}
          </button>
          {rest > PAGE && (
            <button type="button" className="text-accent hover:underline" onClick={() => setShown(entries.length)}>
              Mostrar todos
            </button>
          )}
          <span className="text-fg-disabled">· o búscalos con la paleta</span>
        </div>
      )}
    </>
  )
}

function Row({ entry, depth }: { entry: DirEntry; depth: number }) {
  const isDir = entry.kind === 'dir'
  const expanded = useWorkspace((s) => s.expanded.has(entry.rel))
  const children = useWorkspace((s) => (isDir ? s.dirs[entry.rel] : undefined))
  const active = useWorkspace((s) => s.activeTab === entry.rel)
  const dirty = useWorkspace((s) => isDirty(s.files[entry.rel]))
  const changedBy = useWorkspace((s) => s.files[entry.rel]?.changedBy)
  const demo = useWorkspace((s) => s.project?.demo ?? false)
  const pendingKind = useWorkspace((s) => s.pending[entry.rel]?.kind)
  const marker = pendingKind ? { create: 'A', modify: 'M', delete: 'D' }[pendingKind] : changedBy === 'agent' && demo ? 'M' : null
  const renaming = useWorkspace((s) => s.renaming === entry.rel)
  const ws = useWorkspace.getState()

  useEffect(() => {
    if (isDir && expanded && !children) void ws.loadDir(entry.rel)
  }, [isDir, expanded, children, entry.rel, ws])

  const onContext = (e: MouseEvent) =>
    openContextMenu(e, [
      ...(isDir
        ? [
            { id: 'nf', label: 'Nuevo archivo', icon: <FilePlus />, onSelect: () => ws.startCreate(entry.rel, 'file') },
            { id: 'nd', label: 'Nueva carpeta', icon: <FolderPlus />, onSelect: () => ws.startCreate(entry.rel, 'dir') },
          ]
        : [
            { id: 'open', label: 'Abrir', icon: <FileText />, onSelect: () => void ws.openFile(entry.rel) },
            ...(pendingKind ? [{ id: 'diff', label: 'Revisar cambios del agente', icon: <GitCompare />, onSelect: () => void ws.reviewChange(entry.rel) }] : changedBy === 'agent' ? [{ id: 'diff', label: 'Ver cambios del agente', icon: <GitCompare />, onSelect: () => void ws.openFile(entry.rel, { diff: true }) }] : []),
          ]),
      { id: 'mention', label: 'Mencionar en el chat', icon: <AtSign />, onSelect: () => useChat.getState().requestInsert(`@${entry.rel}${isDir ? '/' : ''} `) },
      {
        id: 'copy',
        label: 'Copiar ruta relativa',
        icon: <Copy />,
        onSelect: () => {
          void navigator.clipboard?.writeText(entry.rel)
          toast({ tone: 'success', title: 'Ruta copiada', description: entry.rel })
        },
      },
      { id: 'sep', separator: true },
      {
        id: 'reveal',
        label: 'Mostrar en el explorador del sistema',
        icon: <ExternalLink />,
        lockedPhase: demo ? 3 : undefined,
        onSelect: () => {
          const p = useWorkspace.getState().project
          if (p) api('fs.reveal', { projectId: p.id, rel: entry.rel }).catch((err) => toast({ tone: 'error', title: 'No se pudo mostrar', description: errorMessage(err) }))
        },
      },
      { id: 'rename', label: 'Renombrar', icon: <Pencil />, shortcut: 'F2', onSelect: () => (demo ? demoOnly() : ws.startRename(entry.rel)) },
      {
        id: 'delete',
        label: 'Mover a la papelera',
        icon: <Trash />,
        danger: true,
        onSelect: async () => {
          if (demo) return demoOnly()
          const ok = await confirm({
            title: 'Mover a la papelera',
            description: `${entry.rel}${isDir ? ' y todo su contenido' : ''} irá a la papelera del sistema. Podrás recuperarlo desde allí.`,
            confirmLabel: 'Mover a la papelera',
            danger: true,
          })
          if (ok) void ws.trashEntry(entry.rel)
        },
      },
    ])

  return (
    <>
      {renaming ? (
        <div className="flex h-6 items-center gap-1.5" style={{ paddingLeft: 6 + depth * 12 + 16 }}>
          <FileIcon name={entry.name} dir={isDir} />
          <InlineInput initial={entry.name} className="h-[22px] text-small" onDone={(v) => (v ? void ws.renameEntry(entry.rel, v) : ws.cancelPending())} />
        </div>
      ) : (
        <div
          role="treeitem"
          aria-expanded={isDir ? expanded : undefined}
          aria-selected={active}
          tabIndex={-1}
          title={entry.symlink ? `${entry.rel} (enlace simbólico)` : entry.rel}
          onClick={() => (isDir ? ws.toggleDir(entry.rel) : void ws.openFile(entry.rel))}
          onKeyDown={(e) => e.key === 'F2' && !demo && ws.startRename(entry.rel)}
          onContextMenu={onContext}
          style={{ paddingLeft: 6 + depth * 12 }}
          className={cn(
            'group flex h-6 cursor-default items-center gap-1.5 rounded-[5px] pr-2 text-fg-2 hover:bg-bg-2 hover:text-fg-1',
            active && 'bg-bg-3 text-fg-1 hover:bg-bg-3',
            entry.ignored && 'opacity-50',
          )}
        >
          <ChevronRight className={cn('size-3 shrink-0 text-fg-3 transition-transform duration-150', expanded && 'rotate-90', !isDir && 'invisible')} />
          <FileIcon name={entry.name} dir={isDir} open={expanded} />
          <span className="truncate">{entry.name}</span>
          {dirty ? (
            <span className="ml-auto size-1.5 shrink-0 rounded-full bg-fg-2" title="Cambios sin guardar" />
          ) : marker ? (
            <span className={cn('ml-auto font-mono text-micro', marker === 'A' ? 'text-ok' : marker === 'D' ? 'text-err' : 'text-git-modified')} title="Cambio del agente pendiente de revisar">
              {marker}
            </span>
          ) : null}
        </div>
      )}
      {isDir && expanded && children && <Children parent={entry.rel} entries={children} depth={depth + 1} />}
      {isDir && expanded && !children && (
        <div style={{ paddingLeft: 6 + (depth + 1) * 12 + 16 }} className="py-1">
          <Spinner size={11} tone="muted" />
        </div>
      )}
    </>
  )
}

function demoOnly() {
  toast({ tone: 'info', title: 'Proyecto de demostración', description: 'Abre una carpeta real para renombrar o eliminar archivos.' })
}
