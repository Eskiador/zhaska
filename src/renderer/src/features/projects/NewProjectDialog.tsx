import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AppWindow, Check, Code, File, Folder, FolderOpen, FlaskConical, Layers, Lock, Server, X } from 'lucide-react'
import { Dialog } from '@renderer/components/ui/overlays'
import { Button } from '@renderer/components/ui/Button'
import { Tooltip } from '@renderer/components/ui/Tooltip'
import { cn } from '@renderer/lib/cn'
import { lockedHint } from '@renderer/lib/phases'
import { api, errorMessage, hasBackend, onEvent } from '@renderer/lib/api'
import type { Project } from '@shared/ipc/contract'
import { toast } from '@renderer/stores/ui'
import { MOD } from '@renderer/lib/platform'
import { adoptProject, createProject, pickAndOpenFolder, useProjects } from '@renderer/stores/projects'
import { useSettings } from '@renderer/stores/settings'
import { useUI } from '@renderer/stores/ui'

type Tab = 'template' | 'folder' | 'clone'

interface Template {
  id: string
  title: string
  detail: string
  icon: typeof File
  /** Comandos que ejecutaría: requieren la terminal y red → Fase 7 */
  lockedPhase?: number
}

const TEMPLATES: Template[] = [
  { id: 'empty', title: 'Vacío', detail: 'Solo una carpeta y Git', icon: File },
  { id: 'react-vite', title: 'React + Vite', detail: 'TypeScript · Vite', icon: Code },
  { id: 'next', title: 'Next.js', detail: 'App Router · TypeScript · Tailwind', icon: Layers },
  { id: 'electron', title: 'Electron + React', detail: 'Escritorio · Vite', icon: AppWindow, lockedPhase: 11 },
  { id: 'node-api', title: 'API con Node', detail: 'Fastify · TypeScript', icon: Server, lockedPhase: 11 },
  { id: 'python', title: 'Python', detail: 'FastAPI · uv · pytest', icon: FlaskConical, lockedPhase: 11 },
]

const NAME_RE = /^[^<>:"/\\|?*\u0000-\u001f]+$/

export function NewProjectDialog() {
  const open = useUI((s) => s.dialog === 'newProject')
  const close = useUI((s) => s.closeDialog)
  const defaultDir = useProjects((s) => s.defaultProjectsDir)
  const projectsDir = useSettings((s) => s.projectsDir)
  const [tab, setTab] = useState<Tab>('template')
  const [name, setName] = useState('')
  const [location, setLocation] = useState('')
  const [template, setTemplate] = useState('empty')
  const [description, setDescription] = useState('')
  const [gitInit, setGitInit] = useState(true)
  const [guide, setGuide] = useState(true)
  const [busy, setBusy] = useState(false)
  const [install, setInstall] = useState(true)
  const [log, setLog] = useState<string[]>([])
  const [cloneUrl, setCloneUrl] = useState('')
  const logRef = useRef<HTMLPreElement>(null)
  const isTemplate = template !== 'empty'

  useEffect(() => {
    if (open) {
      setTab('template')
      setName('')
      setDescription('')
      setLocation(projectsDir || defaultDir)
    }
  }, [open, projectsDir, defaultDir])

  const pickLocation = async () => {
    const p = await api('dialog.pickFolder', { title: 'Ubicación del proyecto', defaultPath: location || undefined }).catch(() => null)
    if (p) setLocation(p)
  }

  const sep = location.includes('\\') ? '\\' : '/'
  const target = name.trim() && location ? `${location.replace(/[\\/]+$/, '')}${sep}${name.trim()}` : ''
  const nameError = useMemo(() => {
    const n = name.trim()
    if (!n) return null
    if (template !== 'empty' && !/^[a-z0-9][a-z0-9._-]*$/.test(n)) return 'Con plantilla: minúsculas, números, «-», «_» o «.» (sin espacios)'
    if (!NAME_RE.test(n)) return 'No puede contener < > : " / \\ | ? *'
    if (/[. ]$/.test(n)) return 'No puede terminar en punto o espacio'
    return null
  }, [name, template])
  const canCreate = hasBackend && !!name.trim() && !nameError && !!location && !busy

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [log])

  /** Ejecuta un trabajo con salida en vivo (plantilla o clonado). */
  const runJob = async (job: (jobId: string) => Promise<Project & { warnings?: string[] }>) => {
    const jobId = crypto.randomUUID()
    setLog([])
    setBusy(true)
    const off = onEvent('projects.log', (e) => e.jobId === jobId && setLog((l) => [...l.slice(-400), e.line]))
    try {
      const p = await job(jobId)
      await adoptProject(p)
      close()
    } catch (e) {
      setLog((l) => [...l, `✗ ${errorMessage(e)}`])
      toast({ tone: 'error', title: 'No se pudo crear el proyecto', description: errorMessage(e) })
    } finally {
      off()
      setBusy(false)
    }
  }

  const submit = async () => {
    if (!canCreate) return
    if (isTemplate) {
      return runJob((jobId) => api('projects.createFromTemplate', { jobId, name: name.trim(), parentDir: location, template: template as 'react-vite' | 'next', gitInit, createGuide: guide, description: description.trim() || undefined, install }))
    }
    setBusy(true)
    const ok = await createProject({ name: name.trim(), parentDir: location, gitInit, createGuide: guide, description: description.trim() || undefined })
    setBusy(false)
    if (ok) close()
  }

  const commandPreview = [
    template === 'react-vite' ? `npm create vite@latest ${name.trim() || '<nombre>'} -- --template react-ts` : template === 'next' ? `npx create-next-app@latest ${name.trim() || '<nombre>'} …` : '',
    gitInit && 'git init -b main',
    guide && 'ZHASKA.md',
    isTemplate && install && 'npm install',
  ]
    .filter(Boolean)
    .join(' · ') || 'mkdir'

  return (
    <Dialog open={open} onClose={close} width={860} bare>
      <div className="flex h-16 items-center gap-4 border-b border-line-subtle px-6">
        <span className="text-title font-semibold">Nuevo proyecto</span>
        <div className="flex rounded-lg border border-line-subtle bg-bg-0 p-0.5">
          {(
            [
              ['template', 'Desde plantilla'],
              ['folder', 'Abrir carpeta'],
              ['clone', 'Clonar repositorio'],
            ] as [Tab, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={cn('flex h-7 items-center gap-1.5 rounded-md px-3 text-body', tab === id ? 'bg-bg-3 text-fg-1' : 'text-fg-3 hover:text-fg-1')}
            >
              {label}
            </button>
          ))}
        </div>
        <button type="button" aria-label="Cerrar" onClick={close} className="ml-auto grid size-7 place-items-center rounded-md text-fg-3 hover:bg-bg-3 hover:text-fg-1">
          <X className="size-4" />
        </button>
      </div>

      {tab === 'template' && (
        <div
          className="space-y-5 px-6 py-5"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit()
          }}
        >
          <div className="grid grid-cols-[1fr_1fr] gap-4">
            <Field label="Nombre del proyecto" hint={nameError ? <span className="text-err">{nameError}</span> : target ? <>Se creará en <span className="font-mono text-fg-2">{target}</span></> : 'Será el nombre de la carpeta'}>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void submit()}
                placeholder="panel-ventas"
                className={cn('h-9 w-full rounded-lg border bg-bg-0 px-3 text-body text-fg-1 outline-none placeholder:text-fg-disabled focus:border-accent', nameError ? 'border-err' : 'border-line')}
              />
            </Field>
            <Field label="Ubicación">
              <div className="flex gap-2">
                {/* Por seguridad la ubicación se elige en el selector del sistema (main solo acepta carpetas elegidas) */}
                <input
                  value={location}
                  readOnly
                  onClick={() => void pickLocation()}
                  title="Pulsa «Elegir…» para cambiar la ubicación"
                  className="h-9 min-w-0 flex-1 cursor-pointer rounded-lg border border-line bg-bg-0 px-3 font-mono text-small text-fg-1 outline-none focus:border-accent"
                />
                <Button icon={<Folder />} className="!h-9" onClick={() => void pickLocation()}>
                  Elegir…
                </Button>
              </div>
            </Field>
          </div>

          <div>
            <div className="mb-2 text-body font-medium text-fg-1">Plantilla</div>
            <div className="grid grid-cols-3 gap-2">
              {TEMPLATES.map((t) => {
                const selected = template === t.id
                const card = (
                  <button
                    key={t.id}
                    type="button"
                    aria-disabled={!!t.lockedPhase}
                    onClick={() => !t.lockedPhase && setTemplate(t.id)}
                    className={cn(
                      'relative flex flex-col items-start gap-3 rounded-[10px] border p-3 text-left transition-colors',
                      selected ? 'border-accent/60 bg-accent-soft' : 'border-transparent hover:bg-bg-2',
                      t.lockedPhase && 'opacity-45 hover:bg-transparent',
                    )}
                  >
                    <span className="grid size-8 place-items-center rounded-lg border border-line bg-bg-2 text-fg-2">
                      <t.icon className="size-4" />
                    </span>
                    <span>
                      <span className="block text-body font-medium text-fg-1">{t.title}</span>
                      <span className="block font-mono text-tiny text-fg-3">{t.detail}</span>
                    </span>
                    {selected && <Check className="absolute top-3 right-3 size-4 text-accent" />}
                    {t.lockedPhase && <Lock className="absolute top-3 right-3 size-3.5 text-fg-3" />}
                  </button>
                )
                return t.lockedPhase ? (
                  <Tooltip key={t.id} content={`${lockedHint(t.lockedPhase)}: necesita ejecutar comandos en la terminal`}>
                    {card}
                  </Tooltip>
                ) : (
                  card
                )
              })}
            </div>
          </div>

          <Field
            label={
              <>
                Describe lo que quieres construir <span className="font-normal text-fg-3">· opcional</span>
              </>
            }
            hint={<>Se guardará en <span className="font-mono">ZHASKA.md</span> como descripción del proyecto para el agente.</>}
          >
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="Ej.: panel de ventas con gráficos por canal, filtros por fecha y exportación a CSV"
              className="w-full resize-none rounded-lg border border-line bg-bg-0 px-3 py-2 text-body text-fg-1 outline-none placeholder:text-fg-disabled focus:border-accent"
            />
          </Field>

          <div className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-[10px] border border-line-subtle bg-bg-0 p-4">
            <Check2 checked={gitInit} onChange={setGitInit} title="Inicializar repositorio Git" detail="Rama main y .gitignore básico (necesita Git instalado)" />
            <Check2 checked={isTemplate && install} onChange={setInstall} disabled={!isTemplate} title="Instalar dependencias" detail={isTemplate ? 'npm install al terminar (necesita Internet)' : 'Solo con plantillas'} />
            <Check2 checked={guide} onChange={setGuide} title="Crear ZHASKA.md" detail="Instrucciones del proyecto para el agente" />
            <Check2 checked={false} onChange={() => {}} disabled title="Abrir en una ventana nueva" detail="Multiventana: más adelante" />
          </div>
        </div>
      )}

      {tab === 'folder' && (
        <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
          <span className="grid size-11 place-items-center rounded-xl border border-line bg-bg-2 text-accent">
            <FolderOpen className="size-5" />
          </span>
          <div className="text-body font-medium">Abrir una carpeta existente</div>
          <div className="max-w-sm text-small text-fg-3">ZHASKA trabajará dentro de esa carpeta: el agente no podrá acceder fuera de ella sin tu permiso.</div>
          <Button
            variant="primary"
            className="mt-2"
            icon={<FolderOpen />}
            onClick={async () => {
              if (await pickAndOpenFolder()) close()
            }}
          >
            Elegir carpeta…
          </Button>
          <div className="text-tiny text-fg-3">También puedes arrastrar una carpeta a la pantalla de bienvenida.</div>
        </div>
      )}

      {tab === 'clone' && (
        <div className="space-y-5 px-6 py-5">
          <Field label="URL del repositorio" hint="https://github.com/usuario/proyecto.git o git@github.com:usuario/proyecto.git · necesita Git instalado">
            <input
              autoFocus
              value={cloneUrl}
              onChange={(e) => setCloneUrl(e.target.value)}
              placeholder="https://github.com/usuario/proyecto.git"
              className="h-9 w-full rounded-lg border border-line bg-bg-0 px-3 font-mono text-small text-fg-1 outline-none placeholder:text-fg-disabled focus:border-accent"
            />
          </Field>
          <Field label="Ubicación" hint={cloneUrl.trim() ? <>Se clonará en <span className="font-mono text-fg-2">{location.replace(/[\\/]+$/, '')}{sep}{cloneUrl.trim().split(/[/:]/).pop()?.replace(/\.git$/, '')}</span></> : undefined}>
            <div className="flex gap-2">
              <input value={location} readOnly onClick={() => void pickLocation()} className="h-9 min-w-0 flex-1 cursor-pointer rounded-lg border border-line bg-bg-0 px-3 font-mono text-small text-fg-1 outline-none focus:border-accent" />
              <Button icon={<Folder />} className="!h-9" onClick={() => void pickLocation()}>
                Elegir…
              </Button>
            </div>
          </Field>
        </div>
      )}

      {log.length > 0 && (
        <pre ref={logRef} className="selectable mx-6 mb-4 max-h-48 overflow-auto rounded-lg border border-line-subtle bg-bg-terminal p-3 font-mono text-tiny leading-[1.6] text-fg-2">
          {log.join('\n')}
        </pre>
      )}

      <div className="flex items-center gap-3 border-t border-line-subtle px-6 py-4">
        {tab === 'template' && (
          <span className="truncate font-mono text-tiny text-fg-3">
            <span className="text-fg-disabled">&gt;_ </span>
            {commandPreview}
          </span>
        )}
        {!hasBackend && <span className="text-tiny text-warn">Disponible en la aplicación de escritorio</span>}
        <div className="ml-auto flex gap-2">
          <Button variant="ghost" onClick={close}>
            Cancelar
          </Button>
          {tab === 'template' && (
            <Button variant="primary" disabled={!canCreate} onClick={() => void submit()}>
              {busy ? 'Creando…' : 'Crear proyecto'}
              <span className="ml-1 font-mono text-micro opacity-70">{MOD}↵</span>
            </Button>
          )}
          {tab === 'clone' && (
            <Button variant="primary" disabled={!hasBackend || busy || !cloneUrl.trim() || !location} onClick={() => void runJob((jobId) => api('projects.clone', { jobId, url: cloneUrl.trim(), parentDir: location }))}>
              {busy ? 'Clonando…' : 'Clonar'}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  )
}

function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-body font-medium text-fg-1">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-small text-fg-3">{hint}</span>}
    </label>
  )
}

function Check2({ checked, onChange, title, detail, disabled }: { checked: boolean; onChange: (v: boolean) => void; title: string; detail: string; disabled?: boolean }) {
  return (
    <button type="button" disabled={disabled} onClick={() => onChange(!checked)} className={cn('flex items-start gap-3 text-left', disabled && 'opacity-45')}>
      <span className={cn('mt-0.5 grid size-4 shrink-0 place-items-center rounded-[4px] border', checked ? 'border-transparent bg-accent-solid text-white' : 'border-line-strong bg-bg-1')}>
        {checked && <Check className="size-3" strokeWidth={3} />}
      </span>
      <span>
        <span className="block text-body text-fg-1">{title}</span>
        <span className="block text-small text-fg-3">{detail}</span>
      </span>
    </button>
  )
}
