import { app, BrowserWindow, session } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDatabase, migrate, pendingMigrations, schemaVersion, type Db } from './db/database'
import { SettingsRepo } from './db/repos'
import { createBackup, ensureDailyBackup } from './db/backups'
import { applyPending, cleanStaging } from './db/restore'
import { backupsDirFor, registerHandlers } from './ipc/handlers'
import { APP_URL, registerAppSchemePrivileges, serveRenderer } from './protocol'
import { AgentHostBridge } from './agentHost'
import { mark } from './startup'

const isMac = process.platform === 'darwin'
const BG = '#09090B'

// Datos de usuario separados de la instalación; en desarrollo, carpeta aparte para no mezclar.
app.setName('ZHASKA')
app.setPath('userData', process.env['ZHASKA_USER_DATA'] || join(app.getPath('appData'), app.isPackaged ? 'ZHASKA' : 'ZHASKA-dev'))

if (!app.requestSingleInstanceLock()) {
  app.quit()
}

registerAppSchemePrivileges()
// Sandbox para todo contenido web, no solo para la ventana principal (checklist de Electron, §4)
app.enableSandbox()

// Cualquier webContents (también los que pudieran crearse en el futuro): sin <webview>, sin ventanas nuevas y sin
// navegar fuera de la página actual. Los enlaces del modelo no son navegables (Markdown.tsx).
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault())
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', (event, url) => {
    if (url !== contents.getURL()) event.preventDefault()
  })
  contents.on('will-redirect', (event, url) => {
    if (url !== contents.getURL()) event.preventDefault()
  })
})

let mainWindow: BrowserWindow | null = null
let db: Db | null = null
let disposeHandlers: (() => void) | null = null
const agentHost = new AgentHostBridge()

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1100,
    minHeight: 680,
    show: false,
    title: 'ZHASKA',
    backgroundColor: BG,
    titleBarStyle: 'hidden',
    ...(isMac ? { trafficLightPosition: { x: 16, y: 13 } } : { titleBarOverlay: { color: BG, symbolColor: '#A3A3AE', height: 40 } }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  })

  win.once('ready-to-show', () => {
    mark('windowShown')
    win.show()
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) void win.loadURL(devUrl)
  else void win.loadURL(APP_URL)
  return win
}

async function initData() {
  const userData = app.getPath('userData')
  const dataDir = join(userData, 'data')
  mkdirSync(dataDir, { recursive: true })
  const dbPath = join(dataDir, 'zhaska.db')
  const backupsDir = backupsDirFor(userData)
  // Restaurar / importar programados: se aplican ANTES de abrir la base de datos (Fase 9)
  const op = await applyPending({ dataDir, dbPath, backupsDir, importDir: join(userData, 'import'), attachmentsDir: join(userData, 'attachments') }).catch((e) => {
    console.error('[restore]', e)
    return null
  })
  if (op) console.log(`[restore] ${op.kind} ${op.ok ? 'aplicado' : `fallido: ${op.error}`}`)
  cleanStaging(join(userData, 'import'), dataDir)
  const isNew = !existsSync(dbPath)
  db = openDatabase(dbPath)

  // Copia antes de migrar una base de datos existente
  if (!isNew && schemaVersion(db) > 0 && pendingMigrations(db).length > 0) await createBackup(db, backupsDir, 'pre-migration')
  migrate(db)

  // Primer arranque tras actualizar: se avisa en la interfaz (los datos y las migraciones ya están en su sitio)
  const settingsRepo = new SettingsRepo(db)
  const lastRun = settingsRepo.get<string | null>('lastRunVersion', null)
  const updatedFrom = lastRun && lastRun !== app.getVersion() ? lastRun : null
  settingsRepo.set('lastRunVersion', app.getVersion())

  const handlers = registerHandlers({
    db,
    dbPath,
    backupsDir,
    // ZHASKA_PROJECTS_DIR aísla la carpeta de proyectos en las pruebas (como ZHASKA_USER_DATA con los datos)
    defaultProjectsDir: process.env['ZHASKA_PROJECTS_DIR'] || join(app.getPath('home'), 'ZHASKA', 'proyectos'),
    window: () => mainWindow,
    agentHost,
    restart,
    updatedFrom,
  })
  disposeHandlers = handlers.dispose
  void ensureDailyBackup(db, backupsDir, handlers.settings.get('backupsKeep', 7)).catch((e) => console.warn('[backup]', e))
}

let restarting = false
/** Cierre ordenado (servicios, agente y base de datos) y nuevo arranque. */
function restart() {
  if (restarting) return
  restarting = true
  // Un instante para que la respuesta IPC llegue a la interfaz («Reiniciando…»)
  setTimeout(() => {
    shutdown()
    app.relaunch()
    app.exit(0)
  }, 400)
}

function shutdown() {
  disposeHandlers?.()
  disposeHandlers = null
  agentHost.dispose()
  try {
    db?.close()
  } catch {
    /* ya cerrada */
  }
  db = null
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.whenReady().then(async () => {
  mark('appReady')
  // Ningún permiso web (cámara, micrófono, notificaciones, geolocalización…).
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)

  serveRenderer(join(__dirname, '../renderer'))
  // El Agent Host se arranca con la primera petición (agentHost.send)
  await initData()
  mark('dataReady')
  mainWindow = createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (!isMac) app.quit()
})

app.on('will-quit', () => shutdown())
