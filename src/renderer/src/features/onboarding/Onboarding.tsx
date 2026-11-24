import { useEffect, useState, type ReactNode } from 'react'
import { Activity, Check, ChevronLeft, CircleAlert, Cpu, Download, FolderOpen, FolderPlus, HardDrive, Lock, Play, Server, Boxes, Sparkles } from 'lucide-react'
import type { DevTools } from '@shared/ipc/contract'
import { estimateFit, recommendVariant } from '@shared/models/catalog'
import { Button } from '@renderer/components/ui/Button'
import { Spinner, Switch } from '@renderer/components/ui/primitives'
import { LogoMark } from '@renderer/components/Logo'
import { cn } from '@renderer/lib/cn'
import { api, errorMessage, hasBackend } from '@renderer/lib/api'
import { formatBytes } from '@renderer/lib/format'
import { catalogHardware, isInstalled, useOllama } from '@renderer/stores/ollama'
import { createProject, openDemo, pickAndOpenFolder, useProjects } from '@renderer/stores/projects'
import { useChat } from '@renderer/stores/chat'
import { useSettings } from '@renderer/stores/settings'
import { useUI } from '@renderer/stores/ui'

const STEPS = ['Bienvenida', 'Entorno local', 'Modelo', 'Primer proyecto']
type CheckState = 'ok' | 'running' | 'warn' | 'error'

/** Asistente de primera ejecución (referencia de diseño, página 5). Cada paso se comprueba de verdad. */
export function Onboarding() {
  const [step, setStep] = useState(0)
  const finish = () => {
    useSettings.getState().set('onboardingDone', true)
    useUI.getState().setOnboarding(false)
  }

  return (
    <div className="fixed inset-x-0 top-0 bottom-0 z-[70] flex animate-fade-in bg-bg-0">
      <aside className="drag relative flex w-[38%] max-w-[520px] min-w-[360px] flex-col border-r border-line-subtle bg-bg-sidebar px-12 pt-16 pb-8" style={{ backgroundImage: 'radial-gradient(rgb(255 255 255 / 0.035) 1px, transparent 1px)', backgroundSize: '18px 18px' }}>
        <div className="flex items-center gap-3">
          <LogoMark size={40} />
          <span className="text-title font-semibold tracking-[0.06em]">ZHASKA</span>
        </div>
        <h1 className="mt-14 text-[30px] leading-[36px] font-semibold">
          Programa con IA
          <br />
          sin que tu código
          <br />
          salga de este equipo.
        </h1>
        <div className="mt-10 space-y-6">
          <Point icon={<Lock />} title="Privado por diseño" text="Los modelos se ejecutan con Ollama en tu máquina. Sin cuentas ni nube." />
          <Point icon={<Cpu />} title="Ajustado a tu hardware" text="Te recomendamos la variante de Gemma que mejor rinde en tu equipo." />
          <Point icon={<Activity />} title="Control total del agente" text="Ves cada archivo que lee, cada cambio y cada comando, y apruebas lo importante." />
        </div>
        <div className="mt-auto text-small text-fg-3">
          Paso {step + 1} de {STEPS.length}
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col px-14 pt-12 pb-8">
        <ol className="flex items-center gap-3 self-center text-body">
          {STEPS.map((s, i) => (
            <li key={s} className="flex items-center gap-3">
              <span className={cn('flex items-center gap-2', i === step ? 'text-fg-1' : 'text-fg-3')}>
                <span className={cn('grid size-6 place-items-center rounded-full border text-small', i < step ? 'border-line text-ok' : i === step ? 'border-transparent bg-accent-solid text-white' : 'border-line')}>
                  {i < step ? <Check className="size-3.5" /> : i + 1}
                </span>
                {s}
              </span>
              {i < STEPS.length - 1 && <span className="h-px w-10 bg-line" />}
            </li>
          ))}
        </ol>

        <div className="mx-auto mt-14 w-full max-w-[640px] flex-1">
          {step === 0 && <WelcomeStep next={() => setStep(1)} />}
          {step === 1 && <EnvironmentStep next={() => setStep(2)} />}
          {step === 2 && <ModelStep next={() => setStep(3)} />}
          {step === 3 && <ProjectStep finish={finish} />}
        </div>

        <div className="mx-auto flex w-full max-w-[640px] items-center justify-between">
          {step > 0 ? (
            <button type="button" onClick={() => setStep(step - 1)} className="flex items-center gap-1 text-body text-fg-2 hover:text-fg-1">
              <ChevronLeft className="size-4" /> Atrás
            </button>
          ) : (
            <span />
          )}
          <button type="button" onClick={finish} className="text-body text-fg-2 hover:text-fg-1">
            Omitir por ahora
          </button>
        </div>
      </main>
    </div>
  )
}

function Point({ icon, title, text }: { icon: ReactNode; title: string; text: string }) {
  return (
    <div className="flex gap-3.5">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-line bg-bg-2 text-accent [&_svg]:size-4">{icon}</span>
      <div>
        <div className="text-body font-medium text-fg-1">{title}</div>
        <div className="mt-0.5 text-body text-fg-3">{text}</div>
      </div>
    </div>
  )
}

function Title({ title, text }: { title: string; text: string }) {
  return (
    <>
      <h2 className="text-title font-semibold">{title}</h2>
      <p className="mt-1.5 text-body text-fg-3">{text}</p>
    </>
  )
}

function WelcomeStep({ next }: { next: () => void }) {
  return (
    <div>
      <Title title="Te damos la bienvenida" text="En unos pasos comprobamos que este equipo puede ejecutar modelos de IA, elegimos el más adecuado y abres tu primer proyecto." />
      <div className="mt-6 rounded-[10px] border border-line-subtle bg-bg-1 p-4 text-body text-fg-2">
        Necesitarás <span className="text-fg-1">Ollama</span> (gratuito) y unos <span className="text-fg-1">5–8 GB</span> de disco para el modelo. La conexión a Internet solo hace falta para descargarlos; después todo funciona sin conexión.
      </div>
      <Button variant="primary" className="mt-6 !h-9" onClick={next}>
        Empezar
      </Button>
    </div>
  )
}

function CheckRow({ state, title, detail, action }: { state: CheckState; title: string; detail?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center gap-3.5 border-b border-line-subtle px-4 py-3.5 last:border-0">
      <span
        className={cn(
          'grid size-7 shrink-0 place-items-center rounded-full border',
          state === 'ok' && 'border-ok/40 bg-ok-soft text-ok',
          state === 'warn' && 'border-warn/40 bg-warn-soft text-warn',
          state === 'error' && 'border-err/40 bg-err-soft text-err',
          state === 'running' && 'border-accent/40 bg-accent-soft',
        )}
      >
        {state === 'ok' ? <Check className="size-3.5" /> : state === 'running' ? <Spinner size={13} tone="accent" /> : <CircleAlert className="size-3.5" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-body text-fg-1">{title}</div>
        {detail && (
          <div className="mt-0.5 truncate text-small text-fg-3" title={typeof detail === 'string' ? detail : undefined}>
            {detail}
          </div>
        )}
      </div>
      {action}
    </div>
  )
}

type Requirements = { os: string; osOk: boolean; osNote: string; arch: string; archOk: boolean; ramGB: number; ramOk: boolean }

function EnvironmentStep({ next }: { next: () => void }) {
  const { status, hardware, installed, installFraction } = useOllama()
  const st = status?.state ?? 'checking'
  const hw = catalogHardware(hardware)
  const rec = recommendVariant(hw)
  const recInstalled = isInstalled(installed, rec.tag)
  const [req, setReq] = useState<Requirements | null>(null)
  const [tools, setTools] = useState<DevTools | null>(null)
  useEffect(() => {
    if (!hasBackend) return
    void api('system.requirements').then(setReq).catch(() => {})
    void api('system.devTools').then(setTools).catch(() => setTools([]))
  }, [])

  if (!hasBackend) return <Title title="Preparando tu entorno local" text="Esta comprobación necesita la aplicación de escritorio." />
  const missing = tools?.filter((t) => !t.version) ?? []

  return (
    <div>
      <Title title="Preparando tu entorno local" text="Comprobamos que este equipo puede ejecutar modelos de IA. Solo tarda unos segundos." />
      <div className="mt-6 overflow-hidden rounded-[10px] border border-line-subtle bg-bg-1">
        <CheckRow
          state={!req ? 'running' : req.osOk && req.archOk ? 'ok' : 'error'}
          title={!req ? 'Comprobando el sistema…' : req.osOk && req.archOk ? 'Sistema compatible' : 'Sistema no compatible'}
          detail={req ? [`${req.os} · ${req.arch}`, req.osNote, !req.archOk ? 'ZHASKA necesita un equipo de 64 bits (x64).' : ''].filter(Boolean).join(' · ') : undefined}
        />
        <CheckRow
          state={!req ? 'running' : req.ramOk ? 'ok' : 'warn'}
          title={!req ? 'Comprobando la memoria…' : req.ramOk ? 'Memoria suficiente' : 'Poca memoria'}
          detail={req ? `${req.ramGB.toLocaleString('es-ES')} GB de RAM${req.ramOk ? '' : ' · con menos de 16 GB usa el perfil Rápido (Gemma 4 e4b)'}` : undefined}
        />
        <CheckRow
          state={st === 'connected' ? 'ok' : st === 'checking' || st === 'starting' ? 'running' : st === 'stopped' ? 'warn' : 'error'}
          title={st === 'connected' ? 'Ollama encontrado' : st === 'stopped' ? 'Ollama instalado, pero detenido' : st === 'not-installed' ? 'Ollama no está instalado' : st === 'error' ? 'Ollama no responde' : 'Buscando Ollama…'}
          detail={st === 'connected' ? <span className="font-mono">v{status?.version} · {status?.host.replace(/^https?:\/\//, '')}</span> : st === 'not-installed' ? 'Es el motor que ejecuta los modelos en tu equipo.' : undefined}
          action={
            st === 'stopped' || st === 'error' ? (
              <Button size="sm" icon={<Play />} onClick={() => void useOllama.getState().start()}>
                Iniciar
              </Button>
            ) : st === 'not-installed' ? (
              <Button size="sm" variant="primary" icon={<Download />} disabled={installFraction !== null} onClick={() => void useOllama.getState().install()}>
                {status?.installing ? (status.installing === 'downloading' ? `${Math.round((installFraction ?? 0) * 100)} %` : 'Instalando…') : 'Instalar'}
              </Button>
            ) : undefined
          }
        />
        <CheckRow
          state={!hardware ? 'running' : hardware.accel === 'cpu' ? 'warn' : 'ok'}
          title={!hardware ? 'Detectando hardware…' : hardware.accel === 'cpu' ? 'Sin aceleración por GPU' : 'Aceleración por GPU disponible'}
          detail={hardware ? (hardware.accel === 'cpu' ? 'Funcionará con la CPU, más despacio.' : `${hardware.accel === 'cuda' ? 'CUDA' : 'Metal'} · ${hw.label}`) : undefined}
        />
        <CheckRow
          state={!hardware ? 'running' : (hardware.diskFreeGB ?? 0) >= 15 ? 'ok' : 'warn'}
          title={(hardware?.diskFreeGB ?? 99) >= 15 ? 'Espacio en disco suficiente' : 'Poco espacio en disco'}
          detail={hardware?.diskFreeGB != null ? `${Math.round(hardware.diskFreeGB)} GB libres · se recomiendan 15 GB` : undefined}
        />
        <CheckRow
          state={st !== 'connected' ? 'warn' : installed.length ? 'ok' : 'warn'}
          title={st !== 'connected' ? 'Modelos instalados: pendiente de Ollama' : installed.length ? `${installed.length} modelo${installed.length > 1 ? 's' : ''} instalado${installed.length > 1 ? 's' : ''}` : 'Todavía no hay modelos'}
          detail={installed.length ? installed.map((m) => m.name).join(' · ') : undefined}
        />
        <CheckRow
          state={!tools ? 'running' : missing.length ? 'warn' : 'ok'}
          title={!tools ? 'Buscando herramientas de desarrollo…' : 'Herramientas de desarrollo'}
          detail={tools ? `${tools.map((t) => `${t.label} ${t.version ?? 'no encontrado'}`).join(' · ')}${missing.length ? ' · no hacen falta para ZHASKA, solo si tus proyectos las usan' : ''}` : undefined}
        />
      </div>

      <div className="mt-5 rounded-[10px] border border-line-subtle bg-bg-1 p-5">
        <div className="text-micro font-medium tracking-[0.06em] text-accent uppercase">Recomendado para tu equipo</div>
        <div className="mt-2 flex items-baseline gap-2">
          <span className="text-[16px] font-semibold">Gemma 4 {rec.size}</span>
          <span className="font-mono text-small text-fg-3">{rec.tag}</span>
          <span className="ml-auto font-mono text-body text-fg-1">{rec.downloadGB.toLocaleString('es-ES')} GB</span>
        </div>
        <div className="mt-1 text-body text-fg-3">
          {rec.note} · contexto de {rec.contextK}K · {estimateFit(rec, hw) === 'gpu' ? 'cabe entero en la GPU' : 'parte en GPU y parte en RAM'}
        </div>
        <div className="mt-4 flex items-center gap-3">
          {recInstalled ? (
            <Button variant="primary" icon={<Check />} onClick={() => (useSettings.getState().set('activeModel', rec.tag), next())}>
              Ya está instalado · Continuar
            </Button>
          ) : (
            <Button
              variant="primary"
              icon={<Download />}
              disabled={st !== 'connected'}
              onClick={() => {
                useSettings.getState().set('activeModel', rec.tag)
                void useOllama.getState().pull(rec.tag)
                next()
              }}
            >
              Descargar y continuar
            </Button>
          )}
          <Button variant="ghost" onClick={() => useUI.getState().openDialog('models')}>
            Elegir otro modelo
          </Button>
          <span className="ml-auto text-small text-fg-3">Podrás cambiarlo cuando quieras</span>
        </div>
      </div>
      {installed.length > 0 && !recInstalled && (
        <button type="button" onClick={next} className="mt-3 text-small text-fg-3 hover:text-fg-1">
          Continuar con un modelo ya instalado →
        </button>
      )}
    </div>
  )
}

function ModelStep({ next }: { next: () => void }) {
  const model = useSettings((s) => s.activeModel)
  const installed = useOllama((s) => s.installed)
  const pull = useOllama((s) => s.pulls[model])
  const [test, setTest] = useState<{ state: CheckState; text: string } | null>(null)
  const [toolTest, setToolTest] = useState<{ state: CheckState; text: string } | null>(null)
  const ready = isInstalled(installed, model)
  const pct = pull?.total ? Math.round((pull.completed / pull.total) * 100) : 0

  useEffect(() => {
    setTest(null)
    setToolTest(null)
  }, [model])

  const runToolTest = async () => {
    setToolTest({ state: 'running', text: 'Proyecto de ejemplo en una carpeta temporal: el modelo debe usar list_files y responder con lo que encuentre…' })
    try {
      const r = await api('models.toolTest', { name: model })
      setToolTest({ state: r.ok ? 'ok' : 'warn', text: `${r.note}${r.called ? ` · ${r.called}` : ''}${r.reply ? ` → «${r.reply.slice(0, 60)}»` : ''} · ${(r.totalMs / 1000).toFixed(1)} s · ${r.tokensPerSec.toFixed(1)} tok/s` })
    } catch (e) {
      setToolTest({ state: 'error', text: errorMessage(e) })
    }
  }

  const runTest = async () => {
    setTest({ state: 'running', text: 'Cargando el modelo y pidiéndole una respuesta corta…' })
    try {
      const r = await api('models.test', { name: model })
      setTest({ state: 'ok', text: `Respondió «${r.reply.slice(0, 40)}» en ${(r.totalMs / 1000).toFixed(1)} s · ${r.tokensPerSec.toFixed(1)} tok/s${r.loadMs > 500 ? ` · carga ${(r.loadMs / 1000).toFixed(1)} s` : ''}` })
    } catch (e) {
      setTest({ state: 'error', text: errorMessage(e) })
    }
  }

  return (
    <div>
      <Title title="Tu modelo" text="El modelo se descarga una sola vez. Después funciona sin conexión." />
      <div className="mt-6 overflow-hidden rounded-[10px] border border-line-subtle bg-bg-1">
        <CheckRow
          state={ready ? 'ok' : pull?.phase === 'error' ? 'error' : pull ? 'running' : 'warn'}
          title={ready ? `${model} listo` : pull ? `Descargando ${model}` : `${model} no está descargado`}
          detail={ready ? 'Descargado en este equipo' : pull ? `${pct} %${pull.total ? ` de ${formatBytes(pull.total)}` : ''}${pull.bytesPerSec ? ` · ${formatBytes(pull.bytesPerSec)}/s` : ''}` : 'Vuelve al paso anterior o elige otro modelo'}
          action={!ready && !pull ? <Button size="sm" icon={<Boxes />} onClick={() => useUI.getState().openDialog('models')}>Elegir modelo</Button> : undefined}
        />
        {pull && !ready && (
          <div className="px-4 pb-4">
            <div className="h-1.5 overflow-hidden rounded-full bg-bg-4">
              <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${pct}%` }} />
            </div>
          </div>
        )}
        <CheckRow
          state={test?.state ?? (ready ? 'warn' : 'warn')}
          title="Prueba de funcionamiento"
          detail={test?.text ?? (ready ? 'Comprueba que el modelo responde en este equipo.' : 'Disponible cuando termine la descarga')}
          action={ready && test?.state !== 'running' ? <Button size="sm" icon={<Play />} onClick={() => void runTest()}>{test ? 'Repetir' : 'Probar'}</Button> : undefined}
        />
        <CheckRow
          state={toolTest?.state ?? 'warn'}
          title="Prueba de herramientas del agente"
          detail={toolTest?.text ?? (ready ? 'Comprueba que el modelo sabe usar una herramienta real (list_files) en un proyecto de ejemplo.' : 'Disponible cuando termine la descarga')}
          action={ready && toolTest?.state !== 'running' ? <Button size="sm" icon={<Play />} onClick={() => void runToolTest()}>{toolTest ? 'Repetir' : 'Probar'}</Button> : undefined}
        />
      </div>
      <Button variant="primary" className="mt-6 !h-9" onClick={next}>
        {ready ? 'Continuar' : 'Continuar mientras se descarga'}
      </Button>
    </div>
  )
}

const FIRST_TASK = 'Crea un archivo index.html con una página de bienvenida sencilla (título «Mi primer proyecto con ZHASKA» y un párrafo que explique qué es) y un style.css con un diseño limpio. Después dime qué has creado.'

function ProjectStep({ finish }: { finish: () => void }) {
  const checkUpdates = useSettings((s) => s.checkUpdates)
  const defaultDir = useProjects((s) => s.defaultProjectsDir)
  const projectsDir = useSettings((s) => s.projectsDir)
  const firstTask = async () => {
    const parentDir = projectsDir || defaultDir
    const existing = useProjects.getState().recents.map((p) => p.name)
    let name = 'mi-primer-proyecto'
    for (let i = 2; existing.includes(name); i++) name = `mi-primer-proyecto-${i}`
    if (await createProject({ name, parentDir, gitInit: true, createGuide: true, description: 'Proyecto de ejemplo creado por el asistente inicial' })) {
      finish()
      // La tarea queda escrita en el chat: el usuario la lee y la envía cuando quiera
      setTimeout(() => {
        useSettings.getState().set('composerMode', 'agent')
        useChat.getState().setDraft(FIRST_TASK)
      }, 300)
    }
  }
  const choice = (icon: ReactNode, title: string, text: string, onClick: () => void, disabled?: boolean) => (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex items-center gap-4 rounded-[10px] border border-line-subtle bg-bg-1 p-4 text-left hover:border-line hover:bg-bg-2 disabled:opacity-45 [&>span>svg]:size-5"
    >
      <span className="grid size-10 shrink-0 place-items-center rounded-lg border border-line bg-bg-2 text-accent">{icon}</span>
      <span>
        <span className="block text-body font-medium text-fg-1">{title}</span>
        <span className="block text-small text-fg-3">{text}</span>
      </span>
    </button>
  )
  return (
    <div>
      <Title title="Tu primer proyecto" text="ZHASKA trabaja dentro de una carpeta. El agente no puede salir de ella sin tu permiso." />
      <div className="mt-6 grid gap-2.5">
        {choice(<Sparkles />, 'Probar el agente con un proyecto de ejemplo', `Crea «mi-primer-proyecto» en ${projectsDir || defaultDir || 'tu carpeta de proyectos'} y deja escrita una primera tarea.`, () => void firstTask(), !hasBackend || !(projectsDir || defaultDir))}
        {choice(<FolderOpen />, 'Abrir una carpeta existente', 'Un proyecto que ya tengas en el ordenador.', async () => {
          if (await pickAndOpenFolder()) finish()
        }, !hasBackend)}
        {choice(<FolderPlus />, 'Crear un proyecto nuevo', 'Carpeta vacía con Git y ZHASKA.md.', () => {
          finish()
          useUI.getState().openDialog('newProject')
        })}
        {choice(<HardDrive />, 'Ver el proyecto de demostración', 'Datos simulados para explorar la interfaz.', () => {
          openDemo()
          finish()
        })}
      </div>
      <div className="mt-5 flex items-center gap-4 rounded-[10px] border border-line-subtle bg-bg-1 p-4">
        <div className="min-w-0 flex-1">
          <div className="text-body text-fg-1">Buscar actualizaciones automáticamente</div>
          <div className="mt-0.5 text-small text-fg-3">Consulta GitHub Releases al iniciar y cada 6 horas. Solo envía la versión instalada; descargar e instalar siempre lo decides tú. Puedes cambiarlo en Configuración → Privacidad y datos.</div>
        </div>
        <Switch checked={checkUpdates} onChange={(v) => useSettings.getState().set('checkUpdates', v)} />
      </div>
      <div className="mt-4 flex items-center gap-2 text-small text-fg-3">
        <Server className="size-3.5" /> Puedes volver a este asistente desde la paleta de comandos ({window.zhaska?.platform === 'darwin' ? '⌘' : 'Ctrl'} K → «Asistente de primera ejecución»).
      </div>
    </div>
  )
}
