import { lazy, Suspense } from 'react'
import { ChevronRight, CircleAlert, FileCode, FileWarning, GitCompare, X } from 'lucide-react'
import { Button } from '@renderer/components/ui/Button'
import { EmptyState, Kbd, Spinner } from '@renderer/components/ui/primitives'
import { cn } from '@renderer/lib/cn'
import { MOD } from '@renderer/lib/platform'
import { FileIcon } from '@renderer/features/explorer/fileIcons'
import { isDirty, useWorkspace } from '@renderer/stores/workspace'
import { useUI } from '@renderer/stores/ui'
import { confirm } from '@renderer/components/ui/confirm'

const CodeEditor = lazy(() => import('./CodeEditor'))
const ProposalDiff = lazy(() => import('./ProposalDiff'))

export function EditorPanel() {
  const tabs = useWorkspace((s) => s.openTabs)
  const active = useWorkspace((s) => s.activeTab)
  const diffTabs = useWorkspace((s) => s.diffTabs)
  const file = useWorkspace((s) => (s.activeTab ? s.files[s.activeTab] : undefined))
  const { setActive, toggleDiff } = useWorkspace.getState()
  const hasOriginal = !!active && file?.original !== undefined
  const inDiff = !!active && diffTabs.has(active)
  const pending = useWorkspace((s) => s.pending)
  const pendingCount = Object.keys(pending).length
  const demo = useWorkspace((s) => s.project?.demo ?? false)
  const showCambios = demo ? hasOriginal : pendingCount > 0 || (inDiff && hasOriginal)

  return (
    <section className="flex h-full min-w-0 flex-col bg-bg-1">
      <div className="flex h-[38px] shrink-0 items-stretch border-b border-line-subtle bg-bg-0">
        <div className="flex min-w-0 flex-1 overflow-x-auto [scrollbar-width:none]">
          {tabs.map((p) => (
            <Tab key={p} path={p} active={p === active} onSelect={() => setActive(p)} onClose={() => void requestClose(p)} />
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-1 px-2">
          {showCambios && (
            <div className="flex rounded-lg border border-line-subtle bg-bg-1 p-0.5 text-small">
              <button type="button" onClick={() => active && inDiff && toggleDiff(active)} className={cn('h-6 rounded-md px-2.5', !inDiff ? 'bg-bg-3 text-fg-1' : 'text-fg-3 hover:text-fg-1')}>
                Código
              </button>
              <button
                type="button"
                onClick={() => {
                  if (demo) return active && !inDiff && toggleDiff(active)
                  const target = active && pending[active] ? active : Object.keys(pending)[0]
                  if (target) void useWorkspace.getState().reviewChange(target)
                  else if (active && hasOriginal && !inDiff) toggleDiff(active)
                }}
                className={cn('flex h-6 items-center gap-1.5 rounded-md px-2.5', inDiff ? 'bg-bg-3 text-fg-1' : 'text-fg-3 hover:text-fg-1')}
              >
                <GitCompare className="size-3.5" />
                Cambios
                {pendingCount > 0 && <span className="rounded-full bg-agent-soft px-1.5 font-mono text-micro text-agent">{pendingCount}</span>}
              </button>
            </div>
          )}
        </div>
      </div>

      {active ? (
        <>
          <div className="flex h-7 shrink-0 items-center gap-1 border-b border-line-subtle px-3.5 text-small text-fg-3">
            {active.split('/').map((seg, i, arr) => (
              <span key={i} className="flex items-center gap-1">
                {i > 0 && <ChevronRight className="size-3" />}
                <span className={i === arr.length - 1 ? 'text-fg-2' : ''}>{seg}</span>
              </span>
            ))}
            {inDiff && <span className="ml-auto text-agent">Original ← → Cambios del agente</span>}
          </div>
          {file?.conflict && (
            <div className="flex shrink-0 items-center gap-2 border-b border-warn/30 bg-warn-soft px-3.5 py-1.5 text-small text-warn">
              <CircleAlert className="size-3.5" />
              El archivo cambió en disco mientras tenías cambios sin guardar.
              <div className="ml-auto flex gap-1.5">
                <Button size="sm" variant="ghost" onClick={() => void useWorkspace.getState().reloadFromDisk(active)}>
                  Recargar desde disco
                </Button>
                <Button size="sm" onClick={() => void useWorkspace.getState().save(active, { force: true })}>
                  Sobrescribir con mis cambios
                </Button>
              </div>
            </div>
          )}
          <div className="relative min-h-0 flex-1">
            {file?.unsupported || file?.error ? (
              <EmptyState
                className="h-full"
                icon={<FileWarning />}
                title={file.error ? 'No se pudo abrir el archivo' : file.unsupported === 'binary' ? 'Archivo binario' : 'Archivo demasiado grande'}
                description={file.error ?? (file.unsupported === 'binary' ? 'El editor solo abre archivos de texto.' : 'El editor abre archivos de hasta 5 MB.')}
              />
            ) : file?.loading ? (
              <div className="grid h-full place-items-center">
                <Spinner tone="muted" />
              </div>
            ) : (
            <Suspense
              fallback={
                <div className="grid h-full place-items-center">
                  <Spinner tone="muted" />
                </div>
              }
            >
              {inDiff && !demo ? <ProposalDiff path={active} /> : <CodeEditor path={active} diff={inDiff} />}
            </Suspense>
            )}
          </div>
        </>
      ) : (
        <EmptyState
          className="flex-1"
          icon={<FileCode />}
          title="Ningún archivo abierto"
          description={
            <>
              Abre un archivo desde el explorador o búscalo con <Kbd>{MOD} K</Kbd>
            </>
          }
        >
          <button type="button" className="text-small text-accent hover:underline" onClick={() => useUI.getState().openDialog('palette')}>
            Buscar archivo
          </button>
        </EmptyState>
      )}
    </section>
  )
}

/** Cerrar una pestaña: si hay cambios sin guardar, pregunta antes. */
async function requestClose(path: string) {
  const ws = useWorkspace.getState()
  if (isDirty(ws.files[path]) && !ws.project?.demo) {
    const save = await confirm({ title: 'Cambios sin guardar', description: `¿Guardar los cambios de ${path.split('/').pop()} antes de cerrar?`, confirmLabel: 'Guardar y cerrar' })
    if (save) {
      if (!(await ws.save(path))) return
    } else {
      const discard = await confirm({ title: 'Descartar cambios', description: 'Se perderán los cambios que no has guardado en este archivo.', confirmLabel: 'Descartar', danger: true })
      if (!discard) return
      useWorkspace.setState((s) => ({ files: { ...s.files, [path]: { ...s.files[path]!, content: s.files[path]!.saved } } }))
    }
  }
  ws.closeTab(path)
}

function Tab({ path, active, onSelect, onClose }: { path: string; active: boolean; onSelect: () => void; onClose: () => void }) {
  const name = path.split('/').pop()!
  const dirty = useWorkspace((s) => isDirty(s.files[path]))
  const agentDemo = useWorkspace((s) => !!s.project?.demo && s.files[path]?.changedBy === 'agent')
  const pendingKind = useWorkspace((s) => s.pending[path]?.kind)
  const marker = pendingKind ? { create: 'A', modify: 'M', delete: 'D' }[pendingKind] : agentDemo ? 'M' : null
  return (
    <div
      role="tab"
      aria-selected={active}
      onClick={onSelect}
      onAuxClick={(e) => e.button === 1 && onClose()}
      className={cn(
        'group flex shrink-0 items-center gap-1.5 border-r border-line-subtle pr-1.5 pl-3 text-body',
        active ? 'bg-bg-1 text-fg-1 shadow-[inset_0_-1px_0_var(--color-accent)]' : 'text-fg-3 hover:text-fg-2',
      )}
    >
      <FileIcon name={name} />
      <span className="whitespace-nowrap">{name}</span>
      {marker && !dirty && (
        <span className={cn('font-mono text-micro', marker === 'A' ? 'text-ok' : marker === 'D' ? 'text-err' : 'text-git-modified')} title="Cambio del agente pendiente de revisar">
          {marker}
        </span>
      )}
      <button
        type="button"
        aria-label={`Cerrar ${name}`}
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        className="grid size-5 place-items-center rounded-sm text-fg-3 hover:bg-bg-3 hover:text-fg-1"
      >
        {dirty ? <span className="size-2 rounded-full bg-fg-2 group-hover:hidden" /> : null}
        <X className={cn('size-3.5', dirty ? 'hidden group-hover:block' : active ? '' : 'opacity-0 group-hover:opacity-100')} />
      </button>
    </div>
  )
}
