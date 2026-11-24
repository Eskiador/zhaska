import { useState, type ReactNode } from 'react'
import { CircleAlert, FolderOpen, FolderPlus, Play, Rocket, X } from 'lucide-react'
import { Kbd } from '@renderer/components/ui/primitives'
import { LogoMark } from '@renderer/components/Logo'
import { cn } from '@renderer/lib/cn'
import { MOD, bridge } from '@renderer/lib/platform'
import { hasBackend } from '@renderer/lib/api'
import { forgetProject, openDemo, openFolderPath, openProjectById, pickAndOpenFolder, useProjects } from '@renderer/stores/projects'
import { relativeTime } from '@renderer/features/sidebar/Sidebar'
import { useUI } from '@renderer/stores/ui'

/** Estado vacío principal: ningún proyecto abierto. Admite arrastrar una carpeta. */
export function Welcome() {
  const recents = useProjects((s) => s.recents)
  const ui = useUI.getState()
  const [dragging, setDragging] = useState(false)

  return (
    <div
      className="relative flex min-h-0 flex-1 items-center justify-center bg-bg-1"
      onDragOver={(e) => {
        if (!hasBackend || !e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        const file = e.dataTransfer.files[0]
        if (file && bridge)
          void bridge.grantDroppedFolder(file).then((path) => {
            if (path) void openFolderPath(path)
          })
      }}
    >
      <div className="w-full max-w-[580px] animate-pop-in px-8">
        <div className="mb-8 flex items-center gap-3.5">
          <LogoMark size={40} />
          <div>
            <div className="text-title font-semibold tracking-[0.06em]">ZHASKA</div>
            <div className="text-body text-fg-3">Programa con IA sin que tu código salga de este equipo.</div>
          </div>
        </div>

        <div className="mb-8 grid grid-cols-3 gap-2.5">
          <Action icon={<FolderOpen />} title="Abrir carpeta" hint={`${MOD} O`} disabled={!hasBackend} onClick={() => void pickAndOpenFolder()} />
          <Action icon={<FolderPlus />} title="Nuevo proyecto" hint={`⇧${MOD} N`} onClick={() => ui.openDialog('newProject')} />
          <Action icon={<Play />} title="Ver demostración" hint="Datos simulados" onClick={openDemo} />
        </div>

        <div className="mb-2 text-micro font-medium tracking-[0.06em] text-fg-3 uppercase">Proyectos recientes</div>
        <div className="mb-8">
          {recents.length === 0 && <div className="rounded-lg border border-dashed border-line px-4 py-5 text-center text-small text-fg-3">{hasBackend ? 'Abre una carpeta o arrástrala aquí para empezar.' : 'Vista de navegador: abre la aplicación de escritorio para trabajar con carpetas reales.'}</div>}
          {recents.map((p) => (
            <div key={p.id} className="group flex h-9 items-center gap-2.5 rounded-md px-2 hover:bg-bg-2">
              <button type="button" disabled={!p.exists} onClick={() => void openProjectById(p.id)} className="flex min-w-0 flex-1 items-center gap-2.5 text-left text-body disabled:cursor-not-allowed">
                <span className="grid size-[20px] shrink-0 place-items-center rounded-[5px] bg-bg-3 text-micro font-semibold text-accent">{p.name.slice(0, 1).toUpperCase()}</span>
                <span className={cn('truncate', p.exists ? 'text-fg-1' : 'text-fg-3')}>{p.name}</span>
                <span className="truncate font-mono text-tiny text-fg-3">{p.rootPath}</span>
              </button>
              {p.exists ? (
                <span className="text-tiny text-fg-3">{relativeTime(p.lastOpenedAt)}</span>
              ) : (
                <span className="flex items-center gap-1 text-tiny text-err">
                  <CircleAlert className="size-3" /> Carpeta no encontrada
                </span>
              )}
              <button type="button" aria-label="Quitar de recientes" title="Quitar de recientes" onClick={() => void forgetProject(p.id)} className="grid size-6 place-items-center rounded-sm text-fg-3 opacity-0 group-hover:opacity-100 hover:bg-bg-3 hover:text-fg-1">
                <X className="size-3.5" />
              </button>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-small text-fg-3">
          <span className="flex items-center gap-1.5">
            <Kbd>{MOD} K</Kbd> Buscar
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>{MOD} ,</Kbd> Configuración
          </span>
          <button type="button" onClick={() => ui.setOnboarding(true)} className="ml-auto flex items-center gap-1.5 text-accent hover:underline">
            <Rocket className="size-3.5" /> Asistente de primera ejecución
          </button>
        </div>
      </div>

      {dragging && (
        <div className="pointer-events-none absolute inset-4 grid animate-fade-in place-items-center rounded-2xl border-2 border-dashed border-accent/60 bg-bg-1/90">
          <div className="flex flex-col items-center gap-2 text-fg-1">
            <FolderOpen className="size-7 text-accent" />
            Suelta la carpeta para abrirla como proyecto
          </div>
        </div>
      )}
    </div>
  )
}

function Action({ icon, title, hint, onClick, disabled }: { icon: ReactNode; title: string; hint: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex flex-col items-start gap-3 rounded-[10px] border border-line-subtle bg-bg-2 p-3.5 text-left transition-colors hover:border-line hover:bg-bg-3 disabled:opacity-45 [&>span>svg]:size-[18px]"
    >
      <span className="text-accent">{icon}</span>
      <span>
        <span className="block text-body font-medium text-fg-1">{title}</span>
        <span className="block text-tiny text-fg-3">{hint}</span>
      </span>
    </button>
  )
}
