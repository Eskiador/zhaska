import { app, BrowserWindow, dialog, ipcMain, shell, utilityProcess } from 'electron'
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { existsSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import { createRequire } from 'node:module'
import type { Db } from '../db/database'
import { schemaVersion } from '../db/database'
import { randomUUID } from 'node:crypto'
import { AgentRepo, AttachmentsRepo, BenchRepo, ConversationsRepo, ProjectsRepo, SettingsRepo } from '../db/repos'
import { AttachmentService } from '../services/attachments'
import { AgentService } from '../services/agent'
import { TerminalService } from '../services/terminals'
import type { AgentHostBridge } from '../agentHost'
import { ChatService } from '../services/chat'
import { AssistantRepo, KnowledgeRepo } from '../assistant/repos'
import { KnowledgeService } from '../assistant/knowledge'
import { AssistantService } from '../assistant/service'
import { checkRequirements, detectDevTools, detectHardware } from '../services/hardware'
import { UpdateService } from '../services/updates'
import { runCommand, defaultShell } from '@core/commands/runner'
import { ModelService } from '../services/models'
import { OllamaSupervisor } from '../services/ollama'
import { DEFAULT_OLLAMA_HOST } from '@shared/ollama/defaults'
import { createBackup, listBackups } from '../db/backups'
import { backupPath, cancelPending, inspectDatabase, schedule, stagingDir, takeLastOperation } from '../db/restore'
import { exportData, exportEstimate, stageImport } from '../data/portable'
import { CheckpointJanitor } from '../services/checkpoints'
import { AppError } from '@core/errors'
import { PathGuard } from '@core/security/pathGuard'
import { FileService } from '@core/workspace/fileService'
import { FileIndex } from '@core/workspace/fileIndex'
import { ProjectWatcher } from '../services/watcher'
import { describeProject, ProjectService } from '../services/projects'
import { blockedReadRoots, workspaceRootProblem } from '@core/security/sensitivePaths'
import { isSettingKey, SETTINGS_SCHEMA } from '@shared/settings'
import { handle, trustedSender } from './router'
import { processStartedAt, startupMarks } from '../startup'

export interface MainContext {
  db: Db
  dbPath: string
  backupsDir: string
  defaultProjectsDir: string
  window: () => BrowserWindow | null
  agentHost: AgentHostBridge
  /** Cierra todo y reinicia la app (restaurar / importar se aplican al arrancar) */
  restart: () => void
  /** Versión anterior si este es el primer arranque tras actualizar */
  updatedFrom: string | null
}

interface Session {
  files: FileService
  watcher: ProjectWatcher | null
  /** Índice de nombres para «Buscar archivo» (se crea con la primera búsqueda) */
  index: FileIndex | null
}

export function registerHandlers(ctx: MainContext) {
  const projectsRepo = new ProjectsRepo(ctx.db)
  const conversations = new ConversationsRepo(ctx.db)
  const settings = new SettingsRepo(ctx.db)

  /**
   * Carpetas elegidas por el usuario en esta sesión (selector nativo o arrastrar a la ventana).
   * Solo con ellas (o la carpeta de proyectos configurada) se puede abrir o crear un proyecto.
   */
  const norm = (p: string) => (process.platform === 'win32' ? resolvePath(p).toLowerCase() : resolvePath(p))
  const granted = new Set<string>()
  const grant = (p: string) => granted.add(norm(p))
  const chosen = (p: string) => {
    if (!isAbsolute(p)) return false
    const n = norm(p)
    const dir = settings.get('projectsDir', '')
    return granted.has(n) || n === norm(ctx.defaultProjectsDir) || (!!dir && n === norm(dir))
  }
  // Se compara con las rutas tal cual y con las reales (enlaces resueltos): en macOS /var es /private/var
  const realOr = (p: string) => {
    try {
      return realpathSync.native(p)
    } catch {
      return p
    }
  }
  const sensitiveCtx = (map: (p: string) => string) => ({
    home: map(app.getPath('home')),
    userData: map(app.getPath('userData')),
    appDir: app.isPackaged ? map(dirname(app.getPath('exe'))) : undefined,
    tempDir: [tmpdir(), realOr(tmpdir())],
  })
  const sensitiveCtxs = [sensitiveCtx((p) => p), sensitiveCtx(realOr)]
  const rootProblem = (p: string) => {
    for (const c of sensitiveCtxs) for (const t of new Set([p, realOr(p)])) {
      const problem = workspaceRootProblem(t, c)
      if (problem) return problem
    }
    return null
  }
  const projects = new ProjectService(projectsRepo, { rootProblem, chosen })

  /** Carpetas autorizadas de un proyecto (fuera de él; el agente solo las lee). */
  type StoredDir = { path: string; addedAt: number }
  const storedDirs = (projectId: string): StoredDir[] => {
    const v = projectsRepo.settings(projectId)['authorizedDirs']
    return Array.isArray(v) ? v.filter((d): d is StoredDir => !!d && typeof (d as StoredDir).path === 'string' && typeof (d as StoredDir).addedAt === 'number') : []
  }
  const authorizedDirs = (projectId: string) => storedDirs(projectId).map((d) => ({ ...d, exists: existsSync(d.path) }))
  const sameDir = (a: string, b: string) => norm(a) === norm(b)
  const benches = new BenchRepo(ctx.db)
  const sessions = new Map<string, Session>()
  const send = (channel: string, payload: unknown) => ctx.window()?.webContents.send(channel, payload)

  const ollama = new OllamaSupervisor(
    settings.get('ollamaHost', DEFAULT_OLLAMA_HOST),
    (status, loaded) => send('ollama.status', { status, loaded }),
    () => settings.get('optimizeMemory', true),
  )
  ollama.startPolling()
  const models = new ModelService(
    () => ollama.api,
    (p) => {
      send('models.pull', p)
      if (p.phase === 'done') void ollama.check()
    },
  )
  // Adjuntos (Fase 8): almacén fuera de los proyectos + extracción en un proceso aparte (utilityProcess, Fase 10)
  // Datos empaquetados con las dependencias (fuentes de pdfjs y datos de OCR eng+spa), resueltos como cualquier paquete
  const pkgDir = (name: string) => dirname(createRequire(__filename).resolve(`${name}/package.json`))
  const attachments = new AttachmentService({
    repo: new AttachmentsRepo(ctx.db),
    root: join(app.getPath('userData'), 'attachments'),
    ocrDir: join(app.getPath('userData'), 'ocr'),
    workerPath: join(__dirname, 'attachments.js'),
    // Proceso aparte (utilityProcess): lee el ASAR de la app instalada y un archivo malicioso no tumba main
    spawn: (file) => utilityProcess.fork(file, [], { serviceName: 'ZHASKA · Adjuntos' }) as never,
    assets: {
      pdfFontsDir: join(pkgDir('pdfjs-dist'), 'standard_fonts'),
      ocrSources: ['eng', 'spa'].map((l) => join(pkgDir(`@tesseract.js-data/${l}`), '4.0.0_best_int', `${l}.traineddata.gz`)),
    },
    ollama: () => ollama.api,
    emit: (row) => send('attachments.updated', row),
  })
  void attachments.init()
  const chat = new ChatService({ conversations, projects: projectsRepo, settings, host: ctx.agentHost, attachments, emit: (e) => send('chat.event', e) })
  const terminals = new TerminalService((channel, payload) => send(channel, payload))
  const agentRepo = new AgentRepo(ctx.db)
  const agent = new AgentService({
    conversations,
    projects: projectsRepo,
    settings,
    agent: agentRepo,
    host: ctx.agentHost,
    checkpointsDir: join(app.getPath('userData'), 'checkpoints'),
    emit: (e) => send('agent.event', e),
    busy: (conversationId) => chat.active().some((t) => t.conversationId === conversationId),
    trash: (abs) => shell.trashItem(abs),
    attachments,
    // Fase 9: lo que el agente puede leer fuera del proyecto (y lo que nunca)
    externalDirs: (projectId) => authorizedDirs(projectId).filter((d) => d.exists).map((d) => d.path),
    blockedDirs: [...new Set([...blockedReadRoots(app.getPath('home'), app.getPath('userData')), ...blockedReadRoots(realOr(app.getPath('home')), realOr(app.getPath('userData')))])],
  })

  // Asistente de empresa (Fase 12): bases de conocimiento locales + chat sin herramientas
  const knowledge = new KnowledgeService({
    repo: new KnowledgeRepo(ctx.db),
    ollama: () => ollama.api,
    embedModel: () => settings.get('embedModel', 'embeddinggemma'),
    extract: (file, ext, dir) => attachments.extractText(file, ext, dir),
    workDir: join(app.getPath('userData'), 'kb-tmp'),
    folderProblem: (abs) => rootProblem(realOr(abs)),
    emit: (p) => send('kb.progress', p),
  })
  rmSync(join(app.getPath('userData'), 'kb-tmp'), { recursive: true, force: true })
  knowledge.init()
  const assistant = new AssistantService({ repo: new AssistantRepo(ctx.db), knowledge, settings, host: ctx.agentHost, attachments, emit: (e) => send('assistant.event', e) })

  // Banco de pruebas: el Agent Host mide; main guarda el resultado con el hardware detectado
  const benchJobs = new Map<string, string>()
  ctx.agentHost.onEvent((e) => {
    if (e.type === 'bench.progress') send('bench.event', { jobId: e.jobId, model: benchJobs.get(e.jobId) ?? '', type: 'progress', step: e.step, index: e.index, total: e.total })
    else if (e.type === 'bench.done') {
      void detectHardware().then((hw) => {
        const record = benches.add(e.result, hw, ollama.status.version)
        send('bench.event', { jobId: e.jobId, model: e.result.model, type: 'done', record })
        benchJobs.delete(e.jobId)
      })
    } else if (e.type === 'bench.error') {
      send('bench.event', { jobId: e.jobId, model: benchJobs.get(e.jobId) ?? '', type: 'error', error: e.message })
      benchJobs.delete(e.jobId)
    }
  })

  /** Sesión de archivos de un proyecto (PathGuard + servicio). Se crea bajo demanda. */
  const session = (projectId: string): Session => {
    let s = sessions.get(projectId)
    if (!s) {
      const p = describeProject(projectsRepo.get(projectId))
      if (!p.exists) throw new AppError('NOT_FOUND', `La carpeta del proyecto ya no existe: ${p.rootPath}`)
      const guard = new PathGuard(p.rootPath)
      s = { files: new FileService(guard, { trash: (abs) => shell.trashItem(abs), reveal: (abs) => shell.showItemInFolder(abs) }), watcher: null, index: null }
      sessions.set(projectId, s)
    }
    return s
  }

  const startWatching = (projectId: string) => {
    // Un único proyecto activo observado a la vez
    for (const [id, s] of sessions) {
      if (id !== projectId && s.watcher) {
        s.watcher.stop()
        s.watcher = null
      }
    }
    const s = session(projectId)
    if (s.watcher) return
    s.watcher = new ProjectWatcher(s.files.guard, (batch) => {
      ctx.window()?.webContents.send('fs.changed', { projectId, ...batch })
      void s.index?.update(batch.files).catch(() => {})
    })
    s.watcher.start()
  }

  handle('app.info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    sqlite: (ctx.db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v,
    userDataPath: app.getPath('userData'),
    dbPath: ctx.dbPath,
    schemaVersion: schemaVersion(ctx.db),
    defaultProjectsDir: ctx.defaultProjectsDir,
    packaged: app.isPackaged,
    updatedFrom: ctx.updatedFrom,
  }))

  handle('app.metrics', () => {
    const NAMES: Record<string, string> = { Browser: 'Proceso principal', Tab: 'Interfaz', GPU: 'GPU', Utility: 'Servicio' }
    // En los utilityProcess, `name` es el serviceName con el que se lanzaron (agente, adjuntos)
    const SERVICES: Record<string, string> = { 'ZHASKA Agent Host': 'Agente', 'ZHASKA · Adjuntos': 'Adjuntos', 'Network Service': 'Red (Chromium)', 'network.mojom.NetworkService': 'Red (Chromium)' }
    const processes = app.getAppMetrics().map((m) => ({
      type: m.type,
      name: SERVICES[m.name ?? ''] ?? SERVICES[m.serviceName ?? ''] ?? NAMES[m.type] ?? m.name ?? m.type,
      pid: m.pid,
      memoryMB: Math.round(m.memory.workingSetSize / 1024),
      cpu: Math.round(m.cpu.percentCPUUsage * 10) / 10,
    }))
    const mu = process.memoryUsage()
    const mb = (b: number) => Math.round(b / 1024 / 1024)
    return { processStartedAt, startup: startupMarks(), processes, totalMB: processes.reduce((a, p) => a + p.memoryMB, 0), main: { heapMB: mb(mu.heapUsed), externalMB: mb(mu.external + mu.arrayBuffers), rssMB: mb(mu.rss) } }
  })

  handle('dialog.pickFolder', async ({ title, defaultPath }) => {
    const win = ctx.window()
    const opts = { title: title ?? 'Elegir carpeta', defaultPath, properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    const picked = r.canceled ? null : (r.filePaths[0] ?? null)
    if (picked) grant(picked)
    return picked
  })

  // Solo el preload lo invoca (no está en la lista blanca de la interfaz): la ruta sale de webUtils.getPathForFile
  // sobre un archivo que el usuario arrastró de verdad, así que cuenta como elegida por él.
  ipcMain.handle('paths.grantDropped', (event, raw: unknown) => {
    if (!trustedSender(event)) return null
    const parsed = z.object({ path: z.string().min(1).max(1024) }).safeParse(raw)
    if (!parsed.success || !isAbsolute(parsed.data.path)) return null
    try {
      if (!statSync(parsed.data.path).isDirectory()) return null
    } catch {
      return null
    }
    grant(parsed.data.path)
    return parsed.data.path
  })

  handle('projects.list', () => projects.list())
  handle('projects.open', ({ id }) => {
    const p = projects.open(id)
    startWatching(id)
    return p
  })
  handle('projects.openFolder', async ({ path }) => {
    const p = await projects.openFolder(path)
    startWatching(p.id)
    return p
  })
  handle('projects.create', async (req) => {
    const p = await projects.create(req)
    startWatching(p.id)
    return p
  })
  handle('projects.createFromTemplate', async ({ jobId, ...req }) => {
    const p = await projects.createFromTemplate(req, (line) => send('projects.log', { jobId, line }))
    startWatching(p.id)
    return p
  })
  handle('projects.clone', async ({ jobId, ...req }) => {
    const p = await projects.clone(req, (line) => send('projects.log', { jobId, line }))
    startWatching(p.id)
    return p
  })
  handle('projects.rename', ({ id, name }) => projects.rename(id, name))
  handle('projects.forget', ({ id }) => {
    sessions.get(id)?.watcher?.stop()
    sessions.delete(id)
    projects.forget(id)
  })
  handle('projects.close', ({ id }) => {
    terminals.killProject(id)
    sessions.get(id)?.watcher?.stop()
    sessions.delete(id)
  })

  handle('projects.authorizedDirs', ({ projectId }) => authorizedDirs(projectsRepo.get(projectId).id))
  handle('projects.authorizeDir', async ({ projectId }) => {
    const project = projectsRepo.get(projectId)
    const win = ctx.window()
    const opts = { title: 'Autorizar una carpeta (el agente podrá leerla, nunca modificarla)', properties: ['openDirectory'] as 'openDirectory'[] }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    const picked = r.canceled ? null : r.filePaths[0]
    if (!picked) return authorizedDirs(project.id)
    const real = realpathSync.native(picked)
    const problem = rootProblem(real)
    if (problem) throw new AppError('FORBIDDEN_PATH', `No se puede autorizar esa carpeta. ${problem}`)
    const rel = new PathGuard(project.rootPath).toRel(real)
    if (rel !== null) throw new AppError('INVALID_INPUT', 'Esa carpeta ya forma parte del proyecto.')
    const list = storedDirs(project.id)
    if (list.some((d) => sameDir(d.path, real))) return authorizedDirs(project.id)
    if (list.length >= 20) throw new AppError('INVALID_INPUT', 'Como máximo 20 carpetas autorizadas por proyecto.')
    projectsRepo.setSetting(project.id, 'authorizedDirs', [...list, { path: real, addedAt: Date.now() }])
    return authorizedDirs(project.id)
  })
  handle('projects.revokeDir', ({ projectId, path }) => {
    const id = projectsRepo.get(projectId).id
    projectsRepo.setSetting(
      id,
      'authorizedDirs',
      storedDirs(id).filter((d) => !sameDir(d.path, path)),
    )
    return authorizedDirs(id)
  })

  handle('kb.list', () => knowledge.list())
  handle('kb.create', ({ name, confidential }) => knowledge.create(name, confidential))
  handle('kb.update', ({ id, name, confidential }) => knowledge.update(id, { name, confidential }))
  handle('kb.delete', ({ id }) => {
    // Las conversaciones guardadas dejan de usar la base borrada
    for (const c of assistant.list()) if (c.collectionIds.includes(id)) assistant.update(c.id, { collectionIds: c.collectionIds.filter((x) => x !== id) })
    knowledge.delete(id)
  })
  handle('kb.addFolder', async ({ id }) => {
    knowledge.get(id)
    const win = ctx.window()
    const opts = { title: 'Añadir una carpeta a la base de conocimiento (solo se lee, nunca se modifica)', properties: ['openDirectory'] as 'openDirectory'[] }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    const picked = r.canceled ? null : r.filePaths[0]
    if (!picked) return null
    return knowledge.addFolder(id, realpathSync.native(picked))
  })
  handle('kb.removeFolder', ({ folderId }) => knowledge.removeFolder(folderId))
  handle('kb.reindex', ({ id }) => {
    knowledge.get(id)
    knowledge.reindex(id)
  })
  handle('kb.documents', ({ id }) => knowledge.documents(id))
  handle('kb.openDocument', async ({ documentId }) => {
    const abs = knowledge.documentPath(documentId)
    if (!existsSync(abs)) throw new AppError('NOT_FOUND', 'El documento ya no está en su carpeta.')
    const err = await shell.openPath(abs)
    if (err) throw new AppError('IO', `No se pudo abrir el documento: ${err}`)
  })
  handle('assistant.list', () => assistant.list())
  handle('assistant.create', (req) => assistant.create(req))
  handle('assistant.update', ({ id, title, collectionIds }) => assistant.update(id, { title, collectionIds }))
  handle('assistant.delete', ({ id }) => assistant.delete(id))
  handle('assistant.messages', ({ conversationId }) => assistant.messages(conversationId))
  handle('assistant.send', (req) => assistant.send(req))
  handle('assistant.cancel', ({ taskId }) => assistant.cancel(taskId))
  handle('assistant.active', () => assistant.active())

  handle('fs.list', ({ projectId, rel }) => session(projectId).files.list(rel))
  handle('fs.read', ({ projectId, rel }) => session(projectId).files.read(rel))
  handle('fs.write', ({ projectId, rel, content, encoding, expectedMtimeMs }) => session(projectId).files.write(rel, content, encoding, expectedMtimeMs))
  handle('fs.create', ({ projectId, rel, kind }) => session(projectId).files.create(rel, kind))
  handle('fs.rename', ({ projectId, from, to }) => session(projectId).files.rename(from, to))
  handle('fs.trash', ({ projectId, rel }) => session(projectId).files.trash(rel))
  handle('fs.reveal', ({ projectId, rel }) => session(projectId).files.reveal(rel))
  handle('fs.findFiles', async ({ projectId, query, limit }) => {
    const s = session(projectId)
    s.index ??= new FileIndex(s.files.guard)
    await s.index.ensure()
    return { files: s.index.search(query, limit), total: s.index.size, truncated: s.index.truncated }
  })

  handle('conversations.list', ({ projectId }) => conversations.list(projectId))
  handle('conversations.create', ({ projectId, title }) => conversations.create(projectsRepo.get(projectId).id, title))
  handle('conversations.rename', ({ id, title }) => conversations.rename(id, title))
  handle('conversations.delete', ({ id }) => conversations.delete(id))
  handle('messages.list', ({ conversationId }) => conversations.messages(conversationId))
  handle('messages.add', ({ conversationId, role, blocks, model }) => conversations.addMessage(conversationId, role, blocks, model ?? null))

  handle('settings.getAll', () => settings.getAll())
  handle('settings.set', ({ key, value }) => {
    if (!isSettingKey(key)) throw new AppError('INVALID_INPUT', `Ajuste desconocido: ${key}`)
    const parsed = SETTINGS_SCHEMA[key].safeParse(value)
    if (!parsed.success) throw new AppError('INVALID_INPUT', `Valor no válido para «${key}»: ${z.prettifyError(parsed.error)}`)
    if (key === 'projectsDir' && value !== '' && !granted.has(norm(String(value)))) throw new AppError('FORBIDDEN_PATH', 'Elige la carpeta de proyectos con el selector.')
    settings.set(key, parsed.data)
    if (key === 'checkpointRetentionDays') setTimeout(runJanitor, 0)
    if (key === 'ollamaHost' && typeof value === 'string') ollama.setHost(value)
  })

  handle('ollama.status', async () => ({ status: await ollama.check(), loaded: ollama.loaded }))
  handle('ollama.start', () => ollama.start())
  handle('ollama.stop', () => ollama.stop())
  handle('ollama.install', () => ollama.install((fraction) => send('ollama.installProgress', { fraction })))
  handle('ollama.logs', () => ollama.getLogs())
  handle('system.hardware', () => detectHardware())
  handle('system.requirements', () => checkRequirements())
  handle('system.devTools', () =>
    detectDevTools(async (command) => {
      const r = await runCommand({ cwd: app.getPath('home'), command, shell: defaultShell('powershell'), timeoutMs: 8000 }).catch(() => null)
      return r && r.exitCode === 0 ? r.output : null
    }),
  )

  handle('models.list', () => models.list())
  handle('models.pull', ({ name }) => models.pull(name, settings.get('modelSource', 'auto')))
  handle('models.pulls', () => models.activePulls())
  handle('models.cancelPull', ({ jobId }) => models.cancelPull(jobId))
  handle('models.delete', async ({ name }) => {
    await models.delete(name)
    void ollama.check()
  })
  handle('models.load', async ({ name }) => {
    await models.load(name)
    void ollama.check()
  })
  handle('models.unload', async ({ name }) => {
    await models.unload(name)
    void ollama.check()
  })

  handle('models.test', ({ name }) => models.test(name))
  handle('models.toolTest', ({ name }) => models.toolTest(name))
  handle('chat.send', (req) => {
    if (agent.isBusy(req.conversationId)) throw new AppError('CONFLICT', 'Ya hay una tarea en curso en esta conversación')
    return chat.send(req)
  })
  handle('agent.start', (req) => agent.start(req))
  handle('attachments.upload', ({ name, data }) => attachments.upload(name, data))
  handle('attachments.get', ({ ids }) => attachments.get(ids))
  handle('attachments.forConversation', ({ conversationId }) => attachments.forConversation(conversationId))
  handle('attachments.remove', ({ id }) => attachments.remove(id))
  handle('attachments.preview', ({ id }) => attachments.preview(id))
  handle('agent.cancel', ({ taskId }) => agent.cancel(taskId))
  handle('agent.approve', ({ taskId, requestId, decision }) => agent.approve(taskId, requestId, decision))
  handle('agent.active', () => agent.active())
  handle('agent.pause', ({ taskId }) => agent.pause(taskId))
  handle('agent.resume', ({ taskId }) => agent.resume(taskId))
  handle('activity.task', ({ taskId }) => agent.activity(taskId))
  handle('activity.latest', ({ conversationId }) => agent.latestActivity(conversationId))
  handle('changes.list', ({ taskId }) => agent.listChanges(taskId))
  handle('changes.accept', ({ taskId, rel }) => agent.accept(taskId, rel))
  handle('changes.reject', ({ taskId, rel, force }) => agent.reject(taskId, rel, force))
  handle('changes.contents', ({ taskId, rel }) => agent.contents(taskId, rel))
  handle('changes.pending', ({ projectId }) => agent.pending(projectId))
  handle('changes.mark', ({ taskId, rel, status }) => agent.mark(taskId, rel, status))
  handle('terminal.create', ({ projectId, cols, rows }) => terminals.create(projectId, describeProject(projectsRepo.get(projectId)).rootPath, settings.get('shell', 'powershell'), cols, rows))
  handle('terminal.write', ({ id, data }) => terminals.write(id, data))
  handle('terminal.resize', ({ id, cols, rows }) => terminals.resize(id, cols, rows))
  handle('terminal.kill', ({ id }) => terminals.kill(id))
  handle('terminal.list', ({ projectId }) => terminals.list(projectId))
  handle('rules.list', ({ projectId }) => agentRepo.rules(projectId))
  handle('rules.delete', ({ id }) => agentRepo.deleteRule(id))
  handle('chat.cancel', ({ taskId }) => chat.cancel(taskId))
  handle('chat.active', () => chat.active())

  handle('bench.run', ({ model }) => {
    const jobId = randomUUID()
    benchJobs.set(jobId, model)
    ctx.agentHost.send({ type: 'bench.start', jobId, host: settings.get('ollamaHost', DEFAULT_OLLAMA_HOST), model, numCtx: settings.get('numCtx', 32768) })
    return { jobId }
  })
  handle('bench.cancel', ({ jobId }) => ctx.agentHost.send({ type: 'bench.cancel', jobId }))
  handle('bench.list', () => benches.list())

  handle('backups.list', () => listBackups(ctx.backupsDir))
  handle('backups.create', () => createBackup(ctx.db, ctx.backupsDir, 'manual'))
  handle('backups.reveal', () => {
    void shell.openPath(ctx.backupsDir)
  })

  // ── Restaurar, exportar e importar (Fase 9) ──
  const userData = app.getPath('userData')
  const dataDir = dirname(ctx.dbPath)
  const tmpDir = join(dataDir, 'tmp')
  const importDir = join(userData, 'import')
  const attachmentsDir = join(userData, 'attachments')
  const busyTasks = () => agent.active().length + chat.active().length + assistant.active().length
  const ensureIdle = () => {
    if (busyTasks()) throw new AppError('CONFLICT', 'Hay una tarea del agente o del chat en curso. Espera a que termine o cancélala antes de continuar.')
  }
  const backupLabel = (file: string) => {
    const b = listBackups(ctx.backupsDir).find((x) => x.file === file)
    return b ? new Date(b.createdAt).toLocaleString('es-ES') : file
  }
  handle('backups.inspect', ({ file }) => inspectDatabase(backupPath(ctx.backupsDir, file), tmpDir))
  handle('backups.restore', ({ file }) => {
    ensureIdle()
    inspectDatabase(backupPath(ctx.backupsDir, file), tmpDir)
    schedule(dataDir, { kind: 'restore', source: file, label: backupLabel(file) })
    ctx.restart()
    return { restarting: true }
  })
  handle('data.exportEstimate', () => exportEstimate(ctx.dbPath, attachmentsDir))
  handle('data.export', async ({ includeAttachments }) => {
    const win = ctx.window()
    const day = new Date().toISOString().slice(0, 10)
    const opts = { title: 'Exportar los datos de ZHASKA', defaultPath: join(app.getPath('documents'), `ZHASKA-datos-${day}.zhaska`), filters: [{ name: 'Datos de ZHASKA', extensions: ['zhaska'] }] }
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (r.canceled || !r.filePath) return null
    const target = r.filePath.toLowerCase().endsWith('.zhaska') ? r.filePath : `${r.filePath}.zhaska`
    if (rootProblem(dirname(target))?.startsWith('Es la carpeta de datos internos')) throw new AppError('FORBIDDEN_PATH', 'Guarda la exportación fuera de la carpeta de datos de ZHASKA.')
    return exportData({ db: ctx.db, target, attachmentsDir, includeAttachments, tmpDir, appVersion: app.getVersion() })
  })
  handle('data.importInspect', async () => {
    ensureIdle()
    const win = ctx.window()
    const opts = {
      title: 'Importar datos de ZHASKA',
      properties: ['openFile'] as 'openFile'[],
      filters: [
        { name: 'Datos o copias de ZHASKA', extensions: ['zhaska', 'db'] },
        { name: 'Todos los archivos', extensions: ['*'] },
      ],
    }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    const file = r.canceled ? null : r.filePaths[0]
    if (!file) return null
    return stageImport({ file, importDir, tmpDir })
  })
  handle('data.importApply', ({ token }) => {
    ensureIdle()
    const dir = stagingDir(importDir, token)
    if (!existsSync(join(dir, 'zhaska.db'))) throw new AppError('NOT_FOUND', 'La importación preparada ya no existe. Vuelve a elegir el archivo.')
    inspectDatabase(join(dir, 'zhaska.db'), tmpDir)
    schedule(dataDir, { kind: 'import', source: token, label: 'datos importados' })
    ctx.restart()
    return { restarting: true }
  })
  handle('data.importCancel', ({ token }) => {
    cancelPending(dataDir)
    rmSync(stagingDir(importDir, token), { recursive: true, force: true })
  })
  handle('data.lastOperation', () => takeLastOperation(dataDir))

  // ── Actualizaciones (Fase 10) ──
  const updates = new UpdateService({
    enabled: () => settings.get('checkUpdates', true) && settings.get('onboardingDone', false),
    emit: (st) => send('update.status', st),
    beforeInstall: async () => {
      await createBackup(ctx.db, ctx.backupsDir, 'pre-update')
    },
    busy: () => busyTasks() > 0,
  })
  updates.start()
  handle('update.status', () => updates.get())
  handle('update.check', () => updates.check())
  handle('update.download', () => updates.download())
  handle('update.install', () => updates.install())

  // ── Retención de instantáneas del agente ──
  const janitor = new CheckpointJanitor({ db: ctx.db, root: join(userData, 'checkpoints'), retentionDays: () => settings.get('checkpointRetentionDays', 30) })
  const runJanitor = () => {
    try {
      const r = janitor.collect()
      if (r.removed) console.log(`[checkpoints] ${r.removed} instantáneas antiguas eliminadas (${r.freedBytes} B)`)
    } catch (e) {
      console.warn('[checkpoints]', e)
    }
  }
  const janitorStart = setTimeout(runJanitor, 60_000)
  const janitorDaily = setInterval(runJanitor, 24 * 3600_000)
  janitorStart.unref()
  janitorDaily.unref()
  handle('checkpoints.usage', () => janitor.usage())
  handle('checkpoints.collect', () => janitor.collect())

  return {
    settings,
    dispose: () => {
      ipcMain.removeHandler('paths.grantDropped')
      clearTimeout(janitorStart)
      clearInterval(janitorDaily)
      updates.dispose()
      sessions.forEach((s) => s.watcher?.stop())
      terminals.dispose()
      attachments.dispose()
      knowledge.dispose()
      ollama.dispose()
    },
  }
}

export const backupsDirFor = (userData: string) => join(userData, 'backups')
