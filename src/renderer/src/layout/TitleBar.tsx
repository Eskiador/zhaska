import { Activity, GitBranch, PanelBottom, PanelLeft, Search, SquareTerminal } from 'lucide-react'
import { Tooltip } from '@renderer/components/ui/Tooltip'
import { IconButton } from '@renderer/components/ui/Button'
import { Kbd } from '@renderer/components/ui/primitives'
import { cn } from '@renderer/lib/cn'
import { inElectron, isMac, MOD } from '@renderer/lib/platform'
import { useLayout } from '@renderer/stores/layout'
import { useUI } from '@renderer/stores/ui'
import { useWorkspace } from '@renderer/stores/workspace'
import { OllamaPill } from '@renderer/features/models/OllamaPill'

/** Barra de título (40 px): proyecto y rama · búsqueda · estado de Ollama · paneles. */
export function TitleBar() {
  const project = useWorkspace((s) => s.project)
  const collapsed = useLayout((s) => s.collapsed)
  const toggle = useLayout((s) => s.toggle)
  const openDialog = useUI((s) => s.openDialog)
  const sidebarHidden = collapsed.sidebar

  return (
    <header
      className={cn(
        'drag flex h-10 shrink-0 items-center gap-2 border-b border-line-subtle bg-bg-0 pr-2 pl-3',
        inElectron && isMac && sidebarHidden && 'pl-[84px]',
        inElectron && !isMac && 'pr-[146px]',
      )}
    >
      {sidebarHidden && <IconButton className="no-drag" label="Mostrar barra lateral" shortcut={`${MOD} B`} icon={<PanelLeft />} onClick={() => toggle('sidebar')} />}

      {project && (
        <div className="no-drag flex min-w-0 items-center gap-2">
          <span className="truncate text-body text-fg-2" title={project.rootPath}>
            {project.name}
          </span>
          {project.branch && (
            <>
              <span className="text-fg-disabled">/</span>
              <span className="flex h-6 items-center gap-1.5 rounded-md border border-line-subtle px-2 font-mono text-tiny text-fg-2">
                <GitBranch className="size-3" />
                {project.branch}
              </span>
            </>
          )}
          {project.demo && (
            <Tooltip content="Proyecto, conversaciones y actividad de ejemplo para revisar la interfaz. No modifica archivos.">
              <span className="rounded-sm border border-warn/30 bg-warn-soft px-1.5 py-px text-micro font-semibold tracking-[0.06em] text-warn">DEMO</span>
            </Tooltip>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={() => openDialog('palette')}
        className="no-drag mx-auto flex h-7 w-[min(440px,34vw)] items-center gap-2 rounded-lg border border-line-subtle bg-bg-1 px-2.5 text-body text-fg-3 hover:border-line"
      >
        <Search className="size-3.5" />
        <span className="truncate">Buscar archivos, comandos o conversaciones</span>
        <Kbd className="ml-auto border-line-subtle">{MOD} K</Kbd>
      </button>

      <OllamaPill />

      {project && (
        <div className="no-drag flex items-center gap-0.5">
          <IconButton label="Barra lateral" shortcut={`${MOD} B`} icon={<PanelLeft />} active={!collapsed.sidebar} onClick={() => toggle('sidebar')} />
          <IconButton label="Actividad" shortcut={`⇧${MOD} I`} icon={<Activity />} active={!collapsed.activity} onClick={() => toggle('activity')} />
          <IconButton label="Editor" icon={<PanelBottom className="rotate-180" />} active={!collapsed.workbench} onClick={() => toggle('workbench')} />
          <IconButton label="Terminal" shortcut={`${MOD} J`} icon={<SquareTerminal />} active={!collapsed.terminal && !collapsed.workbench} onClick={() => toggle('terminal')} />
        </div>
      )}
    </header>
  )
}
