import { CircleArrowDown, CircleX, GitBranch, ShieldCheck, TriangleExclamationPoint, Unplug } from 'lucide-react'
import { useUpdates } from '@renderer/stores/updates'
import { useUI } from '@renderer/stores/ui'
import { openMenuAt } from '@renderer/components/ui/overlays'
import { Tooltip } from '@renderer/components/ui/Tooltip'
import { APP_VERSION } from '@renderer/lib/platform'
import { languageOf } from '@renderer/features/editor/languages'
import { useActivity } from '@renderer/stores/activity'
import { AUTONOMY_LABEL, useSettings, type Autonomy } from '@renderer/stores/settings'
import { useWorkspace } from '@renderer/stores/workspace'
import { useOllama } from '@renderer/stores/ollama'
import { useChat } from '@renderer/stores/chat'

export function StatusBar() {
  const project = useWorkspace((s) => s.project)
  const active = useWorkspace((s) => s.activeTab)
  const eol = useWorkspace((s) => (s.activeTab ? s.files[s.activeTab]?.eol : undefined))
  const encoding = useWorkspace((s) => (s.activeTab ? s.files[s.activeTab]?.encoding : undefined))
  // Errores aún vigentes: fallos sin un paso posterior completado con la misma herramienta y objetivo.
  const failed = useActivity((s) =>
    s.state.steps.filter(
      (st, i, all) => st.status === 'failed' && !all.slice(i + 1).some((o) => o.tool === st.tool && o.target === st.target && o.status === 'completed'),
    ).length,
  )
  const mode = useSettings((s) => s.autonomy)
  const model = useSettings((s) => s.activeModel)
  const ollama = useOllama((s) => s.status?.state)
  const version = useOllama((s) => s.status?.version)
  const last = useChat((s) => s.lastMetrics)
  const update = useUpdates((s) => s.status)
  const showUpdate = update && ['available', 'downloading', 'downloaded'].includes(update.state)

  return (
    <footer className="flex h-6 shrink-0 items-center gap-3.5 border-t border-line bg-bg-0 px-2.5 text-tiny text-fg-3 [&_svg]:size-3">
      {project?.branch && (
        <span className="flex items-center gap-1">
          <GitBranch />
          {project.branch}
        </span>
      )}
      {project && (
        <Tooltip content="Errores detectados por el agente en la tarea actual">
          <span className="flex items-center gap-1">
            <CircleX className={failed ? 'text-err' : ''} />
            {failed}
            <TriangleExclamationPoint className="ml-1.5" />0
          </span>
        </Tooltip>
      )}
      <button
        type="button"
        className="flex items-center gap-1 rounded-sm px-1 text-accent hover:bg-bg-2"
        onClick={(e) =>
          openMenuAt(
            e.currentTarget,
            (Object.keys(AUTONOMY_LABEL) as Autonomy[]).map((m) => ({
              id: m,
              label: AUTONOMY_LABEL[m],
              checked: m === mode,
              onSelect: () => useSettings.getState().setAutonomy(m),
            })),
          )
        }
      >
        <ShieldCheck />
        Agente: {AUTONOMY_LABEL[mode]}
      </button>

      <span className="ml-auto flex items-center gap-1">
        {ollama === 'connected' ? <span className="size-1.5 rounded-full bg-ok" /> : <Unplug />}
        {ollama === 'connected' ? `Ollama ${version ?? ''}` : ollama === 'not-installed' ? 'Ollama no instalado' : 'Ollama sin conectar'}
      </span>
      <span className="font-mono">{model}</span>
      {last && <span className="font-mono" title={`Última respuesta: ${last.evalTokens} tokens en ${(last.evalMs / 1000).toFixed(1)} s`}>{last.tokensPerSec.toLocaleString('es-ES', { maximumFractionDigits: 1 })} tok/s</span>}
      {active && (
        <>
          <span>{languageOf(active).label}</span>
          {eol && <span>{encoding === 'utf8-bom' ? 'UTF-8 con BOM' : 'UTF-8'} · {eol}</span>}
        </>
      )}
      {showUpdate && (
        <button type="button" className="flex items-center gap-1 rounded-sm px-1 text-accent hover:bg-bg-2" onClick={() => useUI.getState().openDialog('settings', 'about')}>
          <CircleArrowDown />
          {update.state === 'available' ? `Actualización ${update.version}` : update.state === 'downloading' ? `Descargando ${update.percent ?? 0} %` : 'Reiniciar para actualizar'}
        </button>
      )}
      <span>v{APP_VERSION}</span>
    </footer>
  )
}
