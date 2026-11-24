import { useEffect, useState, type ReactNode } from 'react'
import { Boxes, Code, Database, Folder, Globe, Info, Keyboard, Layers, Lock, Package, Palette, Pencil, Search, Server, Settings2, Shield, SquareTerminal, X, BookOpen } from 'lucide-react'
import type { AppInfo, Backup, Metrics } from '@shared/ipc/contract'
import { DEFAULT_PROTECTED_PATTERNS, PROTECTED_PATTERN_RE } from '@shared/protectedFiles'
import { REFERENCE_HARDWARE } from '@shared/models/catalog'
import { Dialog } from '@renderer/components/ui/overlays'
import { confirm } from '@renderer/components/ui/confirm'
import { Button } from '@renderer/components/ui/Button'
import { Badge, Kbd, Segmented, Select, Slider, Switch, TextInput } from '@renderer/components/ui/primitives'
import { LogoMark } from '@renderer/components/Logo'
import { cn } from '@renderer/lib/cn'
import { api, errorMessage, hasBackend } from '@renderer/lib/api'
import { formatBytes } from '@renderer/lib/format'
import { APP_VERSION, MOD, bridge } from '@renderer/lib/platform'
import { CURRENT_PHASE, lockedHint } from '@renderer/lib/phases'
import { useProjects } from '@renderer/stores/projects'
import { AUTONOMY_LABEL, useSettings, type ActionPolicy, type Autonomy, type PermissionAction } from '@renderer/stores/settings'
import { toast, useUI, type SettingsSection } from '@renderer/stores/ui'
import { ModelsPage, OllamaPage } from './OllamaPages'
import { useWorkspace } from '@renderer/stores/workspace'
import { useUpdates } from '@renderer/stores/updates'

type AuthorizedDir = { path: string; addedAt: number; exists: boolean }

interface NavItem {
  id: SettingsSection
  label: string
  icon: typeof Info
  description: string
  keywords: string
}

const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: 'General',
    items: [
      { id: 'general', label: 'General', icon: Settings2, description: 'Idioma, proyectos y arranque.', keywords: 'idioma carpeta proyectos inicio último' },
      { id: 'appearance', label: 'Apariencia', icon: Palette, description: 'Tema, densidad y animaciones.', keywords: 'tema oscuro claro densidad animaciones movimiento' },
      { id: 'editor', label: 'Editor', icon: Code, description: 'Editor de código y terminal integrada.', keywords: 'fuente tabulación ajuste línea minimapa terminal shell powershell' },
      { id: 'shortcuts', label: 'Atajos de teclado', icon: Keyboard, description: 'Combinaciones disponibles en toda la aplicación.', keywords: 'atajos teclado combinaciones' },
    ],
  },
  {
    group: 'Inteligencia artificial',
    items: [
      { id: 'models', label: 'Modelos', icon: Boxes, description: 'Modelo activo y banco de pruebas en este equipo.', keywords: 'gemma modelo visión banco pruebas rendimiento benchmark' },
      { id: 'ollama', label: 'Ollama', icon: Server, description: 'El servidor local que ejecuta los modelos. ZHASKA se conecta a él por HTTP en este equipo.', keywords: 'servidor api host memoria' },
      { id: 'agent', label: 'Agente y permisos', icon: Shield, description: 'Decide qué puede hacer la IA por su cuenta en tus proyectos.', keywords: 'permisos autonomía comandos archivos internet protegidos carpetas autorizadas fuera proyecto' },
      { id: 'context', label: 'Contexto e indexado', icon: Layers, description: 'Cuánto puede considerar el modelo y cómo genera.', keywords: 'contexto tokens temperatura razonamiento verificación' },
    ],
  },
  {
    group: 'Sistema',
    items: [
      { id: 'privacy', label: 'Privacidad y datos', icon: Lock, description: 'Qué sale de este equipo, copias de seguridad, exportar e importar.', keywords: 'privacidad datos copias seguridad backup restaurar exportar importar instantáneas checkpoints actualizaciones telemetría' },
      { id: 'about', label: 'Acerca de ZHASKA', icon: Info, description: 'Versión e información del sistema.', keywords: 'versión sistema electron' },
    ],
  },
]

const ALL = NAV.flatMap((g) => g.items)

export function SettingsDialog() {
  const open = useUI((s) => s.dialog === 'settings')
  const section = useUI((s) => s.settingsSection)
  const close = useUI((s) => s.closeDialog)
  const openDialog = useUI((s) => s.openDialog)
  const [q, setQ] = useState('')
  const current = ALL.find((i) => i.id === section) ?? ALL[0]!
  const matches = (i: NavItem) => !q || `${i.label} ${i.keywords}`.toLowerCase().includes(q.toLowerCase())

  return (
    <Dialog open={open} onClose={close} width={980} bare>
      <div className="flex h-[min(660px,80vh)]">
        <nav className="flex w-[236px] shrink-0 flex-col border-r border-line-subtle bg-bg-0 p-3">
          <div className="px-1.5 pt-1 pb-3 text-[15px] font-semibold">Configuración</div>
          <div className="relative mb-3">
            <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-3" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar ajustes" className="h-8 w-full rounded-lg border border-line-subtle bg-bg-1 pr-2 pl-8 text-body text-fg-1 outline-none placeholder:text-fg-3 focus:border-accent" />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {NAV.map((g) => {
              const items = g.items.filter(matches)
              if (!items.length) return null
              return (
                <div key={g.group} className="mb-3">
                  <div className="px-2 pb-1.5 text-micro font-medium tracking-[0.06em] text-fg-3 uppercase">{g.group}</div>
                  {items.map((i) => (
                    <button
                      key={i.id}
                      type="button"
                      onClick={() => openDialog('settings', i.id)}
                      className={cn('flex h-[30px] w-full items-center gap-2.5 rounded-md px-2 text-left text-body', i.id === section ? 'bg-bg-3 text-fg-1' : 'text-fg-2 hover:bg-bg-2 hover:text-fg-1')}
                    >
                      <i.icon className={cn('size-4', i.id === section && 'text-accent')} />
                      {i.label}
                    </button>
                  ))}
                </div>
              )
            })}
          </div>
          <div className="px-2 pt-2 text-tiny text-fg-3">{hasBackend ? 'Los cambios se guardan automáticamente.' : 'Vista de navegador: los cambios se guardan solo en este navegador.'}</div>
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-start gap-4 border-b border-line-subtle px-7 pt-6 pb-5">
            <div className="min-w-0">
              <div className="text-title font-semibold">{current.label}</div>
              <div className="mt-1 text-body text-fg-3">{current.description}</div>
            </div>
            <button type="button" aria-label="Cerrar" onClick={close} className="ml-auto grid size-7 shrink-0 place-items-center rounded-md text-fg-3 hover:bg-bg-3 hover:text-fg-1">
              <X className="size-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-7 pb-6">
            {section === 'general' && <GeneralSection />}
            {section === 'appearance' && <AppearanceSection />}
            {section === 'editor' && <EditorSection />}
            {section === 'shortcuts' && <ShortcutsSection />}
            {section === 'models' && <ModelsPage />}
            {section === 'ollama' && <OllamaPage />}
            {section === 'agent' && <AgentSection />}
            {section === 'context' && <ContextSection />}
            {section === 'privacy' && <PrivacySection />}
            {section === 'about' && <AboutSection />}
          </div>
        </div>
      </div>
    </Dialog>
  )
}

/* ───────── Piezas ───────── */

function Group({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <div className="mt-6">
      <div className="text-body font-medium text-fg-1">{title}</div>
      {description && <div className="mt-0.5 text-small text-fg-3">{description}</div>}
      <div className="mt-3 overflow-hidden rounded-[10px] border border-line-subtle">{children}</div>
    </div>
  )
}

function Row({ icon, label, description, children, lockedPhase }: { icon?: ReactNode; label: string; description?: ReactNode; children: ReactNode; lockedPhase?: number }) {
  return (
    <div className="flex items-center gap-4 border-b border-line-subtle bg-bg-1 px-4 py-3 last:border-0">
      {icon && <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-line-subtle bg-bg-2 text-fg-2 [&_svg]:size-4">{icon}</span>}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-body text-fg-1">
          {label}
          {lockedPhase && (
            <Badge tone="warn">
              <Lock /> Fase {lockedPhase}
            </Badge>
          )}
        </div>
        {description && <div className="mt-0.5 text-small text-fg-3">{description}</div>}
      </div>
      <div className={cn('shrink-0', lockedPhase && 'pointer-events-none opacity-45')} title={lockedPhase ? lockedHint(lockedPhase) : undefined}>
        {children}
      </div>
    </div>
  )
}

function Note({ children }: { children: ReactNode }) {
  return <div className="mt-4 rounded-lg border border-line-subtle bg-bg-2 px-3.5 py-2.5 text-small text-fg-2">{children}</div>
}

function useAppInfo() {
  const [info, setInfo] = useState<AppInfo | null>(null)
  useEffect(() => {
    if (hasBackend) void api('app.info').then(setInfo).catch(() => {})
  }, [])
  return info
}

/* ───────── Secciones ───────── */

function GeneralSection() {
  const s = useSettings()
  const defaultDir = useProjects((x) => x.defaultProjectsDir)
  return (
    <Group title="Proyectos">
      <Row label="Idioma">
        <Select value={s.language} onChange={() => {}} className="w-40">
          <option value="es">Español</option>
        </Select>
      </Row>
      <Row label="Carpeta de proyectos" description={<span className="font-mono">{s.projectsDir || defaultDir || '~/ZHASKA/proyectos'}</span>}>
        <div className="flex gap-2">
          {s.projectsDir && (
            <Button size="sm" variant="ghost" onClick={() => s.set('projectsDir', '')}>
              Restablecer
            </Button>
          )}
          <Button
            size="sm"
            icon={<Folder />}
            disabled={!hasBackend}
            onClick={async () => {
              const p = await api('dialog.pickFolder', { title: 'Carpeta de proyectos', defaultPath: s.projectsDir || defaultDir || undefined }).catch(() => null)
              if (p) s.set('projectsDir', p)
            }}
          >
            Elegir…
          </Button>
        </div>
      </Row>
      <Row label="Abrir el último proyecto al iniciar">
        <Switch checked={s.openLastProject} onChange={(v) => s.set('openLastProject', v)} />
      </Row>
    </Group>
  )
}

function AppearanceSection() {
  const s = useSettings()
  return (
    <Group title="Apariencia">
      <Row label="Tema" description="El tema claro está previsto en los tokens de diseño; no forma parte de la v1.">
        <Segmented value="dark" onChange={() => {}} options={[{ value: 'dark', label: 'Oscuro' }, { value: 'light', label: 'Claro', disabled: true }]} />
      </Row>
      <Row label="Densidad" description="Espaciado de listas y paneles.">
        <Segmented value={s.uiDensity} onChange={(v) => s.set('uiDensity', v)} options={[{ value: 'comfortable', label: 'Cómoda' }, { value: 'compact', label: 'Compacta' }]} />
      </Row>
      <Row label="Reducir movimiento" description="Detiene todas las animaciones. También se respeta la preferencia del sistema.">
        <Switch checked={s.reduceMotion} onChange={(v) => s.set('reduceMotion', v)} />
      </Row>
    </Group>
  )
}

function EditorSection() {
  const s = useSettings()
  return (
    <>
      <Group title="Editor">
        <Row label="Tamaño de fuente">
          <Select value={s.editorFontSize} onChange={(e) => s.set('editorFontSize', Number(e.target.value))} className="w-28">
            {[11, 12, 12.5, 13, 14, 15, 16].map((n) => (
              <option key={n} value={n}>
                {n} px
              </option>
            ))}
          </Select>
        </Row>
        <Row label="Tabulación">
          <Segmented value={String(s.editorTabSize)} onChange={(v) => s.set('editorTabSize', Number(v))} options={[{ value: '2', label: '2 espacios' }, { value: '4', label: '4 espacios' }]} />
        </Row>
        <Row label="Ajuste de línea">
          <Switch checked={s.editorWordWrap} onChange={(v) => s.set('editorWordWrap', v)} />
        </Row>
        <Row label="Minimapa">
          <Switch checked={s.editorMinimap} onChange={(v) => s.set('editorMinimap', v)} />
        </Row>
      </Group>
      <Group title="Terminal">
        <Row icon={<SquareTerminal />} label="Shell predeterminado" description="Para terminales nuevas y para los comandos del agente.">
          <Select value={s.shell} onChange={(e) => s.set('shell', e.target.value as typeof s.shell)} className="w-52">
            <option value="powershell">PowerShell</option>
            <option value="cmd">Símbolo del sistema</option>
            <option value="gitbash">Git Bash (si está instalado)</option>
          </Select>
        </Row>
        <Row label="Tamaño de fuente">
          <Select value={s.terminalFontSize} onChange={(e) => s.set('terminalFontSize', Number(e.target.value))} className="w-28">
            {[11, 12, 13, 14].map((n) => (
              <option key={n} value={n}>
                {n} px
              </option>
            ))}
          </Select>
        </Row>
      </Group>
    </>
  )
}

const SHORTCUTS: [string, string][] = [
  ['Buscar archivos, comandos y conversaciones', `${MOD} K`],
  ['Nueva conversación', `${MOD} N`],
  ['Nuevo proyecto', `⇧ ${MOD} N`],
  ['Abrir carpeta', `${MOD} O`],
  ['Guardar archivo', `${MOD} S`],
  ['Configuración', `${MOD} ,`],
  ['Mostrar/ocultar barra lateral', `${MOD} B`],
  ['Mostrar/ocultar explorador', `⇧ ${MOD} E`],
  ['Mostrar/ocultar actividad', `⇧ ${MOD} I`],
  ['Mostrar/ocultar terminal', `${MOD} J`],
  ['Modo agente · IDE · completo', `${MOD} 1 · 2 · 3`],
  ['Renombrar archivo (explorador)', 'F2'],
]

function ShortcutsSection() {
  return (
    <Group title="Atajos">
      {SHORTCUTS.map(([label, keys]) => (
        <Row key={label} label={label}>
          <Kbd className="h-6 px-2 text-small">{keys}</Kbd>
        </Row>
      ))}
    </Group>
  )
}

const AUTONOMY_DESC: Record<Autonomy, string> = {
  ask: 'Apruebas cada lectura, edición y comando.',
  balanced: 'Lee libremente y pide permiso para editar o ejecutar.',
  autonomous: 'Edita y ejecuta comandos permitidos sin preguntar.',
}

const ACTIONS: { id: PermissionAction; label: string; detail: string; icon: ReactNode }[] = [
  { id: 'read', label: 'Leer archivos del proyecto', detail: 'Explorar carpetas y abrir archivos para entender el código.', icon: <BookOpen /> },
  { id: 'write', label: 'Crear y modificar archivos', detail: 'Los cambios se muestran como propuesta hasta que los aceptas.', icon: <Pencil /> },
  { id: 'execute', label: 'Ejecutar comandos en la terminal', detail: 'Los comandos peligrosos siempre piden confirmación.', icon: <SquareTerminal /> },
  { id: 'install', label: 'Instalar dependencias', detail: 'npm, pnpm, yarn y pip dentro del proyecto.', icon: <Package /> },
  { id: 'internet', label: 'Acceso a internet', detail: 'ZHASKA funciona sin conexión; actívalo solo si una tarea lo requiere.', icon: <Globe /> },
]

function AgentSection() {
  const s = useSettings()
  return (
    <>
      <div className="mt-6 text-body font-medium text-fg-1">Nivel de autonomía</div>
      <div className="mt-0.5 text-small text-fg-3">Se aplica a todas las conversaciones nuevas.</div>
      <div className="mt-3 grid grid-cols-3 gap-2.5">
        {(['ask', 'balanced', 'autonomous'] as Autonomy[]).map((a) => (
          <button
            key={a}
            type="button"
            onClick={() => s.setAutonomy(a)}
            className={cn('rounded-[10px] border p-3.5 text-left transition-colors', s.autonomy === a ? 'border-accent/70 bg-accent-soft' : 'border-line-subtle bg-bg-1 hover:border-line')}
          >
            <div className="flex items-center gap-2 text-body text-fg-1">
              <span className={cn('grid size-3.5 place-items-center rounded-full border', s.autonomy === a ? 'border-accent' : 'border-line-strong')}>{s.autonomy === a && <span className="size-1.5 rounded-full bg-accent" />}</span>
              {AUTONOMY_LABEL[a]}
              {a === 'balanced' && <Badge tone="agent">Recomendado</Badge>}
            </div>
            <div className="mt-1.5 text-small text-fg-3">{AUTONOMY_DESC[a]}</div>
          </button>
        ))}
      </div>
      <Group title="Permisos por acción" description="Lo que el agente hace cuando necesita cada tipo de acceso.">
        {ACTIONS.map((a) => (
          <Row key={a.id} icon={a.icon} label={a.label} description={a.detail}>
            <Select
              value={s.permissions[a.id]}
              onChange={(e) => s.set('permissions', { ...s.permissions, [a.id]: e.target.value as ActionPolicy })}
              className="w-36"
            >
              <option value="allow">Permitir</option>
              <option value="ask">Preguntar</option>
              <option value="block">Bloquear</option>
            </Select>
          </Row>
        ))}
      </Group>
      <RulesGroup />
      <ProtectedGroup />
      <AuthorizedDirsGroup />
      <Note>
        Fuera del proyecto, con privilegios elevados, con comandos destructivos, al eliminar archivos (también con un comando) o al leer o tocar archivos protegidos siempre se pide confirmación, sea cual sea el nivel. Los comandos «seguros» (git status, npm test, tsc --noEmit…) no preguntan salvo en «Preguntar siempre»; con «npm run», se revisa lo que ejecuta de verdad el script de package.json.
      </Note>
    </>
  )
}

function ContextSection() {
  const s = useSettings()
  return (
    <>
      <Group title="Contexto">
        <Row label="Ventana de contexto" description={`Tokens que el modelo considera a la vez. Con ${REFERENCE_HARDWARE.vramGB} GB de VRAM, 32K es el equilibrio recomendado.`}>
          <Select value={s.numCtx} onChange={(e) => s.set('numCtx', Number(e.target.value))} className="w-36">
            {[8192, 16384, 32768, 65536].map((n) => (
              <option key={n} value={n}>
                {n / 1024}K tokens
              </option>
            ))}
          </Select>
        </Row>
        <Row label="Máximo de pasos por tarea" description="El agente se detiene al llegar a este número de acciones; puedes pedirle que continúe.">
          <Select value={s.agentMaxSteps} onChange={(e) => s.set('agentMaxSteps', Number(e.target.value))} className="w-28">
            {[15, 30, 50, 80].map((n) => (
              <option key={n} value={n}>
                {n} pasos
              </option>
            ))}
          </Select>
        </Row>
        <Row label="Protocolo de herramientas" description="Automático: herramientas nativas si el modelo las admite (Gemma 4); si no, JSON estructurado.">
          <Select value={s.agentProtocol} onChange={(e) => s.set('agentProtocol', e.target.value as typeof s.agentProtocol)} className="w-44">
            <option value="auto">Automático</option>
            <option value="native">Nativo (tools)</option>
            <option value="json">JSON estructurado</option>
          </Select>
        </Row>
        <Row label="Contexto del proyecto" description="El agente recibe un resumen de la estructura, la configuración detectada y ZHASKA.md; el resto lo consulta con herramientas. Se ignoran node_modules, .git, dist, build…">
          <Badge>Automático</Badge>
        </Row>
      </Group>
      <Group title="Generación">
        <Row label="Temperatura" description="Valores bajos dan respuestas más deterministas: recomendable para editar código.">
          <div className="flex items-center gap-3">
            <Slider value={s.temperature} min={0} max={1.5} step={0.05} onChange={(v) => s.set('temperature', v)} />
            <span className="w-9 text-right font-mono text-small text-fg-2">{s.temperature.toFixed(2)}</span>
          </div>
        </Row>
        <Row label="Razonamiento (thinking)" description="El modelo razona antes de responder. Su contenido no se muestra ni se guarda.">
          <Switch checked={s.thinking} onChange={(v) => s.set('thinking', v)} />
        </Row>
        <Row label="Verificación automática" description="Tras modificar archivos, el agente comprueba tipos y errores antes de terminar.">
          <Switch checked={s.autoVerify} onChange={(v) => s.set('autoVerify', v)} />
        </Row>
      </Group>
    </>
  )
}

const REASON_LABEL: Record<string, string> = {
  daily: 'Diaria',
  manual: 'Manual',
  'pre-migration': 'Antes de actualizar',
  'pre-restore': 'Antes de restaurar',
  'pre-import': 'Antes de importar',
}

const fmtDate = (ms: number) => new Date(ms).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' })

/** Pantalla de «Reiniciando…» mientras se aplica una restauración o importación. */
function restartingToast() {
  toast({ tone: 'info', title: 'Reiniciando ZHASKA…', description: 'Se guarda una copia del estado actual y se aplican los datos elegidos.' })
}

function PrivacySection() {
  const s = useSettings()
  return (
    <>
      <Group title="Lo que sale de este equipo">
        <Row icon={<Shield />} label="Telemetría" description="ZHASKA no envía estadísticas de uso ni el contenido de tus proyectos a ningún servidor.">
          <Badge tone="ok">Ninguna</Badge>
        </Row>
        <Row label="Buscar actualizaciones" description="Consulta GitHub Releases al iniciar y cada 6 horas. Solo envía la versión instalada, nunca datos de tus proyectos. Descargar e instalar siempre lo decides tú.">
          <Switch checked={s.checkUpdates} onChange={(v) => s.set('checkUpdates', v)} />
        </Row>
        <Row label="Proveedores externos de IA" description="Desactivados. Ollama solo puede estar en este equipo. Si algún día añades otro, se pedirá tu autorización expresa.">
          <Badge>Ninguno</Badge>
        </Row>
      </Group>
      <BackupsGroup />
      <PortableGroup />
      <CheckpointsGroup />
    </>
  )
}

function BackupsGroup() {
  const s = useSettings()
  const info = useAppInfo()
  const [backups, setBackups] = useState<Backup[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [all, setAll] = useState(false)
  const refresh = () => {
    if (hasBackend) void api('backups.list').then(setBackups).catch(() => setBackups([]))
  }
  useEffect(refresh, [])
  const latest = backups?.[0]
  const shown = all ? (backups ?? []) : (backups ?? []).slice(0, 5)

  const restore = async (b: Backup) => {
    setBusy(b.file)
    try {
      const sum = await api('backups.inspect', { file: b.file })
      const ok = await confirm({
        title: 'Restaurar esta copia',
        description: `Tus datos de ZHASKA volverán al ${fmtDate(b.createdAt)}: ${sum.projects} proyecto${sum.projects === 1 ? '' : 's'}, ${sum.conversations} conversaci${sum.conversations === 1 ? 'ón' : 'ones'} y sus ajustes. Lo posterior se sustituye, pero antes se guarda una copia del estado actual («Antes de restaurar») para que puedas volver. Tus carpetas de proyecto no se tocan. ZHASKA se reiniciará.`,
        confirmLabel: 'Restaurar y reiniciar',
        danger: true,
      })
      if (!ok) return
      await api('backups.restore', { file: b.file })
      restartingToast()
    } catch (e) {
      toast({ tone: 'error', title: 'No se puede restaurar esa copia', description: errorMessage(e) })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Group title="Copias de seguridad" description="Copias de la base de datos (proyectos recientes, conversaciones, actividad y ajustes), separadas de la instalación: actualizar o reinstalar no las borra.">
      <Row icon={<Database />} label="Ubicación de tus datos" description={<span className="selectable font-mono">{info?.userDataPath ?? '—'}</span>}>
        <Button size="sm" variant="ghost" disabled={!hasBackend} onClick={() => void api('backups.reveal').catch(() => {})}>
          Abrir carpeta de copias
        </Button>
      </Row>
      <Row label="Copias" description={backups === null ? 'Disponibles en la aplicación de escritorio.' : latest ? `${backups.length} copia${backups.length === 1 ? '' : 's'} · última: ${fmtDate(latest.createdAt)} (${formatBytes(latest.size)})` : 'Todavía no hay copias.'}>
        <Button
          size="sm"
          disabled={!hasBackend || !!busy}
          onClick={async () => {
            setBusy('create')
            try {
              const b = await api('backups.create')
              toast({ tone: 'success', title: 'Copia creada', description: b.file })
              refresh()
            } catch (e) {
              toast({ tone: 'error', title: 'No se pudo crear la copia', description: errorMessage(e) })
            } finally {
              setBusy(null)
            }
          }}
        >
          {busy === 'create' ? 'Creando…' : 'Crear copia ahora'}
        </Button>
      </Row>
      <Row label="Copias diarias que se conservan" description="Además se guardan copias antes de cada actualización, restauración o importación.">
        <Select value={s.backupsKeep} onChange={(e) => s.set('backupsKeep', Number(e.target.value))} className="w-32">
          {[3, 7, 14, 30].map((n) => (
            <option key={n} value={n}>
              {n} copias
            </option>
          ))}
        </Select>
      </Row>
      {shown.map((b) => (
        <Row key={b.file} label={fmtDate(b.createdAt)} description={`${REASON_LABEL[b.reason] ?? b.reason} · ${formatBytes(b.size)}`}>
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void restore(b)}>
            {busy === b.file ? 'Comprobando…' : 'Restaurar…'}
          </Button>
        </Row>
      ))}
      {(backups?.length ?? 0) > 5 && (
        <div className="bg-bg-1 px-4 py-2">
          <Button size="sm" variant="ghost" onClick={() => setAll((v) => !v)}>
            {all ? 'Ver menos' : `Ver todas (${backups!.length})`}
          </Button>
        </div>
      )}
    </Group>
  )
}

function PortableGroup() {
  const [estimate, setEstimate] = useState<{ dbBytes: number; attachmentsBytes: number; attachmentFiles: number } | null>(null)
  const [withAttachments, setWithAttachments] = useState(true)
  const [busy, setBusy] = useState<'export' | 'import' | null>(null)
  useEffect(() => {
    if (hasBackend) void api('data.exportEstimate').then(setEstimate).catch(() => {})
  }, [])

  const doExport = async () => {
    setBusy('export')
    try {
      const r = await api('data.export', { includeAttachments: withAttachments })
      if (r) toast({ tone: 'success', title: 'Datos exportados', description: `${r.file} (${formatBytes(r.size)}${r.attachments ? `, ${r.attachments} archivos de adjuntos` : ''})` })
    } catch (e) {
      toast({ tone: 'error', title: 'No se pudo exportar', description: errorMessage(e) })
    } finally {
      setBusy(null)
    }
  }

  const doImport = async () => {
    setBusy('import')
    try {
      const sum = await api('data.importInspect')
      if (!sum) return
      const ok = await confirm({
        title: 'Importar estos datos',
        description: `«${sum.fileName}» (${fmtDate(sum.createdAt)}${sum.appVersion ? `, ZHASKA ${sum.appVersion}` : ''}): ${sum.projects} proyecto${sum.projects === 1 ? '' : 's'}, ${sum.conversations} conversaci${sum.conversations === 1 ? 'ón' : 'ones'}${sum.attachmentFiles ? ` y ${sum.attachmentFiles} archivos de adjuntos` : ''}. Sustituirán a tus datos actuales de ZHASKA; antes se guarda una copia del estado actual («Antes de importar») para que puedas volver. Tus carpetas de proyecto no se tocan; si están en otra ruta, tendrás que abrirlas de nuevo. ZHASKA se reiniciará.`,
        confirmLabel: 'Importar y reiniciar',
        danger: true,
      })
      if (!ok) {
        await api('data.importCancel', { token: sum.token }).catch(() => {})
        return
      }
      await api('data.importApply', { token: sum.token })
      restartingToast()
    } catch (e) {
      toast({ tone: 'error', title: 'No se pudo importar', description: errorMessage(e) })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Group title="Exportar e importar" description="Para llevarte tus datos a otro equipo o guardar una copia completa donde quieras. El archivo se crea en este equipo; ZHASKA no lo sube a ningún sitio.">
      <Row label="Incluir adjuntos" description={estimate ? `${estimate.attachmentFiles} archivos · ${formatBytes(estimate.attachmentsBytes)}. Sin ellos, el archivo ocupa unos ${formatBytes(estimate.dbBytes)}.` : 'PDF, imágenes y demás archivos que adjuntaste en las conversaciones.'}>
        <Switch checked={withAttachments} onChange={setWithAttachments} disabled={!hasBackend} />
      </Row>
      <Row label="Exportar mis datos" description="Un archivo .zhaska con proyectos recientes, conversaciones, actividad, permisos y ajustes. Tu código no se incluye: está en tus carpetas.">
        <Button size="sm" disabled={!hasBackend || !!busy} onClick={() => void doExport()}>
          {busy === 'export' ? 'Exportando…' : 'Exportar…'}
        </Button>
      </Row>
      <Row label="Importar datos" description="Desde un archivo .zhaska o una copia .db. Antes de sustituir nada se comprueba el archivo y se te muestra lo que contiene.">
        <Button size="sm" disabled={!hasBackend || !!busy} onClick={() => void doImport()}>
          {busy === 'import' ? 'Comprobando…' : 'Importar…'}
        </Button>
      </Row>
    </Group>
  )
}

function CheckpointsGroup() {
  const s = useSettings()
  const [usage, setUsage] = useState<{ bytes: number; blobs: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const refresh = () => {
    if (hasBackend) void api('checkpoints.usage').then(setUsage).catch(() => {})
  }
  useEffect(refresh, [])
  return (
    <Group title="Instantáneas de los cambios del agente" description="Copia de cada archivo antes y después de que el agente lo cambie: permite ver el diff y rechazar el cambio. Las de cambios pendientes de revisar se conservan siempre.">
      <Row label="Conservar durante">
        <Select
          value={s.checkpointRetentionDays}
          onChange={(e) => {
            s.set('checkpointRetentionDays', Number(e.target.value))
            setTimeout(refresh, 800)
          }}
          className="w-32"
        >
          {[7, 14, 30, 90, 365].map((n) => (
            <option key={n} value={n}>
              {n} días
            </option>
          ))}
        </Select>
      </Row>
      <Row label="Espacio usado" description={usage ? `${formatBytes(usage.bytes)} en ${usage.blobs} instantánea${usage.blobs === 1 ? '' : 's'}` : 'Disponible en la aplicación de escritorio.'}>
        <Button
          size="sm"
          variant="ghost"
          disabled={!hasBackend || busy}
          onClick={async () => {
            setBusy(true)
            try {
              const r = await api('checkpoints.collect')
              toast({ tone: 'success', title: r.removed ? 'Espacio liberado' : 'Nada que limpiar', description: r.removed ? `${r.removed} instantáneas antiguas (${formatBytes(r.freedBytes)})` : `Todas están dentro del plazo de ${s.checkpointRetentionDays} días o son de cambios pendientes.` })
              refresh()
            } catch (e) {
              toast({ tone: 'error', title: 'No se pudo limpiar', description: errorMessage(e) })
            } finally {
              setBusy(false)
            }
          }}
        >
          Liberar espacio ahora
        </Button>
      </Row>
    </Group>
  )
}

function AboutSection() {
  const info = useAppInfo()
  const rows: [string, string][] = info
    ? [
        ['Versión', `${info.version} · Fase ${CURRENT_PHASE}`],
        ['Sistema', `${info.platform} ${info.arch}`],
        ['Electron · Chromium · Node', `${info.electron} · ${info.chrome.split('.')[0]} · ${info.node}`],
        ['SQLite', `${info.sqlite} · esquema v${info.schemaVersion}`],
        ['Base de datos', info.dbPath],
      ]
    : [
        ['Versión', `${APP_VERSION} · Fase ${CURRENT_PHASE}`],
        ['Entorno', bridge ? 'Electron' : 'Vista de navegador'],
      ]
  return (
    <>
      <div className="flex items-center gap-4 pt-6">
        <LogoMark size={48} />
        <div>
          <div className="text-title font-semibold tracking-[0.06em]">ZHASKA</div>
          <div className="text-body text-fg-3">IDE de programación con IA local · Ollama</div>
        </div>
      </div>
      <Group title="Información">
        {rows.map(([k, v]) => (
          <Row key={k} label={k}>
            <span className="selectable max-w-[380px] truncate font-mono text-small text-fg-2" title={v}>
              {v}
            </span>
          </Row>
        ))}
        <Row label="Equipo de referencia" description="El equipo para el que se ajustan los modelos. El tuyo se detecta en Configuración → Modelos.">
          <span className="font-mono text-small text-fg-2">
            {REFERENCE_HARDWARE.gpu} {REFERENCE_HARDWARE.vramGB} GB · {REFERENCE_HARDWARE.ramGB} GB RAM
          </span>
        </Row>
        <PerfRow />
        <UpdatesRow />
      </Group>
    </>
  )
}

function ProtectedGroup() {
  const s = useSettings()
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const isDefault = s.protectedPatterns.length === DEFAULT_PROTECTED_PATTERNS.length && s.protectedPatterns.every((p, i) => p === DEFAULT_PROTECTED_PATTERNS[i])
  const add = () => {
    const p = draft.trim().replace(/\\/g, '/')
    if (!p) return
    if (!PROTECTED_PATTERN_RE.test(p)) return setError('Usa un patrón relativo al proyecto, sin «..» ni rutas absolutas (p. ej. secrets/** o *.sqlite).')
    if (s.protectedPatterns.includes(p)) return setError('Ese patrón ya está en la lista.')
    if (s.protectedPatterns.length >= 100) return setError('Como máximo 100 patrones.')
    s.set('protectedPatterns', [...s.protectedPatterns, p])
    setDraft('')
    setError(null)
  }
  return (
    <Group title="Archivos protegidos" description="El agente te pide confirmación antes de leerlos o modificarlos (también con comandos) y su contenido no entra en las búsquedas. «*» es cualquier nombre y «**», cualquier carpeta.">
      <div className="bg-bg-1 p-4">
        <div className="flex flex-wrap gap-1.5">
          {s.protectedPatterns.length === 0 && <span className="text-small text-fg-3">Ninguno: el agente podrá leer y editar cualquier archivo del proyecto según tus permisos.</span>}
          {s.protectedPatterns.map((p) => (
            <span key={p} className="flex items-center gap-1 rounded-md border border-line-subtle bg-bg-2 py-0.5 pr-1 pl-2 font-mono text-small text-fg-2">
              {p}
              <button type="button" aria-label={`Quitar ${p}`} onClick={() => s.set('protectedPatterns', s.protectedPatterns.filter((x) => x !== p))} className="grid size-4 place-items-center rounded-sm text-fg-3 hover:bg-bg-4 hover:text-fg-1">
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
        <form
          className="mt-3 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            add()
          }}
        >
          <TextInput value={draft} onChange={(e) => (setDraft(e.target.value), setError(null))} placeholder="Añadir patrón, p. ej. config/secretos.json" className="h-8 flex-1 font-mono" aria-label="Nuevo patrón protegido" />
          <Button size="sm" type="submit" disabled={!draft.trim()}>
            Añadir
          </Button>
          {!isDefault && (
            <Button size="sm" variant="ghost" type="button" onClick={() => s.set('protectedPatterns', [...DEFAULT_PROTECTED_PATTERNS])}>
              Restaurar predeterminados
            </Button>
          )}
        </form>
        {error && <div className="mt-2 text-small text-err">{error}</div>}
      </div>
    </Group>
  )
}

function AuthorizedDirsGroup() {
  const project = useWorkspace((x) => x.project)
  const [dirs, setDirs] = useState<AuthorizedDir[]>([])
  const [busy, setBusy] = useState(false)
  const real = hasBackend && project && !project.demo
  useEffect(() => {
    if (real) void api('projects.authorizedDirs', { projectId: project.id }).then(setDirs).catch(() => setDirs([]))
    else setDirs([])
  }, [project?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const run = async (fn: () => Promise<AuthorizedDir[]>) => {
    setBusy(true)
    try {
      setDirs(await fn())
    } catch (e) {
      toast({ tone: 'error', title: 'No se pudo autorizar la carpeta', description: errorMessage(e) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Group title="Carpetas autorizadas fuera del proyecto" description="El agente puede leerlas sin preguntar (por ejemplo, una librería compartida), pero nunca modificarlas. Cualquier otra ruta fuera del proyecto necesita tu permiso cada vez.">
      {!real ? (
        <div className="bg-bg-1 px-4 py-3 text-small text-fg-3">Abre un proyecto para gestionar sus carpetas autorizadas.</div>
      ) : (
        <>
          {dirs.length === 0 && <div className="border-b border-line-subtle bg-bg-1 px-4 py-3 text-small text-fg-3">Ninguna. El agente solo trabaja dentro de {project.name}.</div>}
          {dirs.map((d) => (
            <Row
              key={d.path}
              icon={<Folder />}
              label={d.path.split(/[\\/]/).pop() || d.path}
              description={
                <span className="selectable font-mono">
                  {d.path}
                  {!d.exists && <span className="ml-2 text-warn">(ya no existe)</span>}
                </span>
              }
            >
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => api('projects.revokeDir', { projectId: project.id, path: d.path }))}>
                Revocar
              </Button>
            </Row>
          ))}
          <div className="bg-bg-1 px-4 py-3">
            <Button size="sm" disabled={busy} onClick={() => void run(() => api('projects.authorizeDir', { projectId: project.id }))}>
              Autorizar carpeta…
            </Button>
          </div>
        </>
      )}
    </Group>
  )
}

/** Arranque y memoria medidos en este equipo (Fase 11). */
function PerfRow() {
  const [m, setM] = useState<Metrics | null>(null)
  const load = () => {
    if (hasBackend) void api('app.metrics').then(setM).catch(() => {})
  }
  useEffect(load, [])
  if (!hasBackend) return null
  const ready = Number(document.documentElement.dataset['ready'] || 0)
  const startup = m && ready ? (ready - m.processStartedAt) / 1000 : null
  return (
    <Row
      label="Rendimiento"
      description={
        m ? (
          <span>
            {startup !== null && `Arranque: ${startup.toLocaleString('es-ES', { maximumFractionDigits: 1 })} s · `}
            Memoria: {m.totalMB.toLocaleString('es-ES')} MB en {m.processes.length} procesos (sin Ollama)
            <span className="mt-0.5 block font-mono text-tiny">{m.processes.map((p) => `${p.name} ${p.memoryMB} MB`).join(' · ')}</span>
          </span>
        ) : (
          'Midiendo…'
        )
      }
    >
      <Button size="sm" variant="ghost" onClick={load}>
        Actualizar
      </Button>
    </Row>
  )
}

function UpdatesRow() {
  const st = useUpdates((x) => x.status)
  const { check, download, install } = useUpdates.getState()
  const checkUpdates = useSettings((x) => x.checkUpdates)
  if (!hasBackend || !st) return <Row label="Actualizaciones" description="Disponibles en la aplicación de escritorio."><span /></Row>
  const when = st.checkedAt ? ` · comprobado ${new Date(st.checkedAt).toLocaleString('es-ES', { timeStyle: 'short', dateStyle: 'short' })}` : ''
  const desc: Record<typeof st.state, string> = {
    unconfigured: st.message ?? 'Sin canal de actualizaciones.',
    idle: checkUpdates ? 'Se comprueba al iniciar y cada 6 horas (solo se envía la versión instalada).' : 'La búsqueda automática está desactivada (Privacidad y datos).',
    checking: 'Buscando…',
    'not-available': `Tienes la última versión${when}.`,
    available: `Disponible la versión ${st.version}${st.releaseDate ? ` (${new Date(st.releaseDate).toLocaleDateString('es-ES')})` : ''}. La descarga la decides tú.`,
    downloading: `Descargando ${st.percent ?? 0} %${st.total ? ` de ${formatBytes(st.total)}` : ''}${st.bytesPerSec ? ` · ${formatBytes(st.bytesPerSec)}/s` : ''}`,
    downloaded: `ZHASKA ${st.version} está descargada y verificada (sha512). Al reiniciar se guarda una copia de tus datos y se instala.`,
    error: st.error ?? 'Error al actualizar.',
  }
  return (
    <>
      <Row label="Actualizaciones" description={<span className={st.state === 'error' ? 'text-err' : undefined}>{desc[st.state]}</span>}>
        {st.state === 'unconfigured' ? (
          <Badge>No configuradas</Badge>
        ) : st.state === 'available' || (st.state === 'error' && st.version) ? (
          <Button size="sm" variant="primary" onClick={() => void download()}>
            Descargar {st.version}
          </Button>
        ) : st.state === 'downloaded' ? (
          <Button size="sm" variant="primary" onClick={() => void install()}>
            Reiniciar e instalar
          </Button>
        ) : (
          <Button size="sm" disabled={st.state === 'checking' || st.state === 'downloading'} onClick={() => void check()}>
            {st.state === 'checking' ? 'Buscando…' : 'Buscar ahora'}
          </Button>
        )}
      </Row>
      {st.notes && ['available', 'downloading', 'downloaded'].includes(st.state) && (
        <div className="border-b border-line-subtle bg-bg-1 px-4 py-3 last:border-0">
          <div className="text-micro font-medium tracking-[0.06em] text-fg-3 uppercase">Novedades de la {st.version}</div>
          <pre className="selectable mt-1.5 max-h-40 overflow-auto font-sans text-small whitespace-pre-wrap text-fg-2">{st.notes}</pre>
        </div>
      )}
    </>
  )
}

function RulesGroup() {
  const project = useWorkspace((x) => x.project)
  const [rules, setRules] = useState<{ id: string; action: string; pattern: string; createdAt: number }[]>([])
  const load = () => {
    if (hasBackend && project && !project.demo) void api('rules.list', { projectId: project.id }).then(setRules).catch(() => setRules([]))
  }
  useEffect(load, [project?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const LABEL: Record<string, string> = { read: 'Leer', write: 'Modificar archivos', execute: 'Ejecutar', install: 'Instalar', internet: 'Internet' }
  return (
    <Group title="Permisos concedidos en este proyecto" description="Lo que aprobaste con «Siempre aquí» desde el panel de actividad.">
      {!project || project.demo ? (
        <div className="bg-bg-1 px-4 py-3 text-small text-fg-3">Abre un proyecto para ver sus permisos.</div>
      ) : rules.length === 0 ? (
        <div className="bg-bg-1 px-4 py-3 text-small text-fg-3">Ninguno todavía.</div>
      ) : (
        rules.map((r) => (
          <Row key={r.id} label={LABEL[r.action] ?? r.action} description={<span className="font-mono">{r.pattern === '*' ? 'cualquiera' : r.pattern}</span>}>
            <Button size="sm" variant="ghost" onClick={() => void api('rules.delete', { id: r.id }).then(load)}>
              Revocar
            </Button>
          </Row>
        ))
      )}
    </Group>
  )
}
