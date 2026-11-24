/**
 * Prueba de humo de la app compilada (npm run smoke).
 * Arranca out/main con datos aislados en una carpeta temporal y comprueba desde la ventana real:
 * seguridad de Electron, protocolo app://, CSP, IPC (validación, PathGuard), SQLite, archivos y arranque.
 * ZHASKA_SMOKE_SHOT=<ruta.png> guarda una captura al final.
 */
const { app } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zhaska-smoke-'))
process.env.ZHASKA_USER_DATA = path.join(tmp, 'userdata')
const projectsDir = path.join(tmp, 'proyectos')

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}
const skip = (name, why) => console.log(`– ${name} — omitido: ${why}`)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
/** Espera una promesa con límite: la prueba nunca se queda colgada. */
const within = (promise, ms, what) => Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(`Tiempo agotado: ${what}`)), ms))])
const MAX_MINUTES = Number(process.env.ZHASKA_SMOKE_MAX_MINUTES || 25)
setTimeout(() => {
  console.log(`✗ la prueba superó ${MAX_MINUTES} minutos y se detuvo`)
  app.exit(2)
}, MAX_MINUTES * 60_000).unref()
const step = (msg) => console.log(`  · ${new Date().toLocaleTimeString('es-ES')} ${msg}`)

/** ZIP mínimo sin comprimir con nombres arbitrarios (incluidos peligrosos) para la prueba de adjuntos. */
function smokeZip(entries) {
  const { crc32 } = require('node:zlib')
  const locals = []
  const centrals = []
  let offset = 0
  for (const [n, d] of entries) {
    const name = Buffer.from(n)
    const data = Buffer.from(d)
    const crc = crc32(data) >>> 0
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42)
    locals.push(lh, name, data)
    centrals.push(ch, name)
    offset += 30 + name.length + data.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}

function findFile(dir, name) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.name === name) return p
    if (e.isDirectory() && !e.isSymbolicLink()) {
      const hit = findFile(p, name)
      if (hit) return hit
    }
  }
  return null
}

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error') console.log(`  [renderer error] ${e.message}`)
  })
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code)
    const invoke = (channel, req) => js(`window.zhaska.invoke(${JSON.stringify(channel)}, ${JSON.stringify(req)})`)
    try {
      await wait(2000)
      const prefs = win.webContents.getLastWebPreferences()
      check('contextIsolation + sandbox, sin nodeIntegration', prefs.contextIsolation && prefs.sandbox && !prefs.nodeIntegration)
      check('la UI no tiene acceso a Node', await js(`typeof require === 'undefined' && typeof process === 'undefined'`))
      check('la UI se sirve por app://', (await js('location.href')).startsWith('app://zhaska/'))
      const csp = await js(`document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content || ''`)
      check('CSP estricta', csp.includes("script-src 'self'") && !csp.includes('unsafe-eval'), csp.slice(0, 60))
      check('canal no listado rechazado en el preload', await js(`window.zhaska.invoke('fs.deleteEverything', {}).then(() => false, () => true)`))

      const info = await invoke('app.info')
      check('app.info + SQLite', info.ok && info.data.schemaVersion >= 1, info.ok ? `SQLite ${info.data.sqlite}, esquema v${info.data.schemaVersion}` : info.error.message)
      const bad = await invoke('projects.open', {})
      check('petición inválida → INVALID_INPUT', !bad.ok && bad.error.code === 'INVALID_INPUT')

      // ── Fase 9: auditoría del IPC. Los diálogos nativos se sustituyen por respuestas fijas de la prueba ──
      step('Fase 9: seguridad del IPC')
      const { dialog } = require('electron')
      let nextPick = null
      let nextSave = null
      dialog.showOpenDialog = async () => (nextPick ? { canceled: false, filePaths: [nextPick] } : { canceled: true, filePaths: [] })
      dialog.showSaveDialog = async () => (nextSave ? { canceled: false, filePath: nextSave } : { canceled: true })
      const notChosen = await invoke('projects.create', { name: 'x', parentDir: projectsDir, gitInit: false, createGuide: false })
      check('crear un proyecto en una carpeta no elegida → FORBIDDEN_PATH', !notChosen.ok && notChosen.error.code === 'FORBIDDEN_PATH')
      const openAny = await invoke('projects.openFolder', { path: os.homedir() })
      check('abrir una carpeta cualquiera sin el selector → FORBIDDEN_PATH', !openAny.ok && openAny.error.code === 'FORBIDDEN_PATH')
      nextPick = os.homedir()
      await invoke('dialog.pickFolder', {})
      const home = await invoke('projects.openFolder', { path: os.homedir() })
      check('ni eligiéndola: la carpeta personal completa no puede ser un proyecto', !home.ok && home.error.code === 'FORBIDDEN_PATH', home.ok ? '' : home.error.message)
      nextPick = projectsDir
      const picked = await invoke('dialog.pickFolder', { title: 'Ubicación' })
      check('el selector concede la carpeta elegida', picked.ok && picked.data === projectsDir)
      nextPick = null
      const k1 = await invoke('settings.set', { key: 'clave-inventada', value: 1 })
      const k2 = await invoke('settings.set', { key: 'temperature', value: 'mucha' })
      const k3 = await invoke('settings.set', { key: 'ollamaHost', value: 'http://servidor-externo.com:11434' })
      check('ajustes: solo claves conocidas, con su tipo, y Ollama solo en este equipo', !k1.ok && !k2.ok && !k3.ok && k3.error.code === 'INVALID_INPUT')
      const sys = await invoke('messages.add', { conversationId: 'x', role: 'system', blocks: [] })
      check('la interfaz no puede inyectar mensajes de sistema', !sys.ok && sys.error.code === 'INVALID_INPUT')
      const hdr = await js(`fetch(location.href).then((r) => r.headers.get('content-security-policy') || '')`)
      check('la CSP también llega como cabecera HTTP de app://', hdr.includes("frame-ancestors 'none'"))
      check('no se pueden abrir ventanas nuevas', await js(`window.open('https://example.com') === null`))

      const created = await invoke('projects.create', { name: 'prueba-humo', parentDir: projectsDir, gitInit: false, createGuide: true, description: 'Proyecto de la prueba de humo' })
      check('crear proyecto', created.ok && fs.existsSync(path.join(projectsDir, 'prueba-humo', 'ZHASKA.md')), created.ok ? created.data.rootPath : created.error.message)
      const pid = created.data.id

      const w = await invoke('fs.write', { projectId: pid, rel: 'src/hola.ts', content: 'export const hola = "¿qué tal?"\r\n', encoding: 'utf8' })
      check('escribir archivo sin carpeta previa falla de forma controlada', !w.ok && w.error.code === 'NOT_FOUND', w.ok ? '' : w.error.code)
      await invoke('fs.create', { projectId: pid, rel: 'src', kind: 'dir' })
      const w2 = await invoke('fs.write', { projectId: pid, rel: 'src/hola.ts', content: 'export const hola = "¿qué tal?"\r\n', encoding: 'utf8' })
      const r = await invoke('fs.read', { projectId: pid, rel: 'src/hola.ts' })
      check('escribir y leer (UTF-8, CRLF)', w2.ok && r.ok && r.data.content.includes('¿qué tal?') && r.data.eol === 'CRLF')
      const list = await invoke('fs.list', { projectId: pid, rel: '' })
      check('listar carpeta', list.ok && list.data.map((e) => e.name).join(',') === 'src,ZHASKA.md', list.ok ? list.data.map((e) => e.name).join(', ') : '')
      const escape = await invoke('fs.read', { projectId: pid, rel: '../../secreto.txt' })
      check('PathGuard bloquea salir del proyecto', !escape.ok && escape.error.code === 'FORBIDDEN_PATH')
      const abs = await invoke('fs.read', { projectId: pid, rel: os.platform() === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/hosts' })
      check('PathGuard bloquea rutas absolutas', !abs.ok && abs.error.code === 'FORBIDDEN_PATH')

      const conv = await invoke('conversations.create', { projectId: pid, title: 'Prueba' })
      await invoke('messages.add', { conversationId: conv.data.id, role: 'user', blocks: [{ kind: 'text', text: 'Hola' }] })
      const msgs = await invoke('messages.list', { conversationId: conv.data.id })
      check('conversación y mensajes en SQLite', msgs.ok && msgs.data.length === 1 && msgs.data[0].blocks[0].text === 'Hola')

      await invoke('settings.set', { key: 'lastProjectId', value: pid })
      await invoke('settings.set', { key: 'onboardingDone', value: true }) // el asistente de primera ejecución taparía la ventana
      const all = await invoke('settings.getAll')
      check('ajustes persistentes', all.ok && all.data.lastProjectId === pid)
      const backup = await invoke('backups.create')
      check('copia de seguridad', backup.ok && fs.existsSync(path.join(process.env.ZHASKA_USER_DATA, 'backups', backup.data.file)))

      // ── Fase 9: carpetas autorizadas, copias, exportar e importar ──
      step('Fase 9: carpetas autorizadas, exportar e importar')
      const extDir = path.join(tmp, 'libreria-compartida')
      fs.mkdirSync(extDir)
      nextPick = extDir
      const auth = await invoke('projects.authorizeDir', { projectId: pid })
      check('autorizar una carpeta fuera del proyecto (solo lectura)', auth.ok && auth.data.length === 1 && auth.data[0].exists, auth.ok ? '' : auth.error.message)
      nextPick = process.env.ZHASKA_USER_DATA
      const authBad = await invoke('projects.authorizeDir', { projectId: pid })
      check('no se pueden autorizar los datos internos de ZHASKA', !authBad.ok && authBad.error.code === 'FORBIDDEN_PATH')
      const rev = auth.ok ? await invoke('projects.revokeDir', { projectId: pid, path: auth.data[0].path }) : { ok: false }
      check('revocar la carpeta autorizada', rev.ok && rev.data.length === 0)
      const insp = await invoke('backups.inspect', { file: backup.data.file })
      check('comprobar una copia antes de restaurarla', insp.ok && insp.data.projects >= 1, insp.ok ? `${insp.data.projects} proyecto(s)` : insp.error.message)
      const insp2 = await invoke('backups.inspect', { file: '../data/zhaska.db' })
      check('restaurar solo acepta copias de la carpeta de copias', !insp2.ok && insp2.error.code === 'INVALID_INPUT')
      const exportFile = path.join(tmp, 'exportado', 'datos.zhaska')
      fs.mkdirSync(path.dirname(exportFile))
      nextSave = exportFile
      const ex = await invoke('data.export', { includeAttachments: true })
      check('exportar los datos a un archivo .zhaska', ex.ok && ex.data && fs.existsSync(exportFile), ex.ok && ex.data ? `${ex.data.size} B` : ex.ok ? 'cancelado' : ex.error.message)
      nextSave = null
      nextPick = exportFile
      const im = await invoke('data.importInspect')
      check('importar: se comprueba y se resume antes de aplicar', im.ok && im.data && im.data.projects >= 1 && im.data.fileName === 'datos.zhaska', im.ok ? '' : im.error.message)
      if (im.ok && im.data) await invoke('data.importCancel', { token: im.data.token })
      check('cancelar la importación no deja nada preparado', !(im.ok && im.data) || !fs.existsSync(path.join(process.env.ZHASKA_USER_DATA, 'import', im.data.token)))
      nextPick = null
      const cu = await invoke('checkpoints.usage')
      check('espacio usado por las instantáneas', cu.ok && typeof cu.data.bytes === 'number')

      step('recargando la ventana')
      // Recarga: la app debe reabrir el último proyecto y mostrar sus archivos y conversaciones desde la BD
      win.webContents.reload()
      await within(new Promise((res) => win.webContents.once('did-finish-load', res)), 30_000, 'recargar la ventana')
      await wait(2500)
      const text = await js('document.body.innerText')
      check('al reiniciar reabre el último proyecto', text.includes('prueba-humo') && text.includes('ZHASKA.md') && text.includes('Prueba'))

      // Watcher: un archivo creado fuera de la app aparece en el explorador
      const root = path.join(projectsDir, 'prueba-humo')
      fs.writeFileSync(path.join(root, 'externo.txt'), 'creado fuera')
      await wait(1200)
      check('el explorador refleja cambios hechos fuera de la app', (await js('document.body.innerText')).includes('externo.txt'))

      step('probando el editor')
      // Editor real: abrir desde el explorador, escribir y guardar con Ctrl/⌘+S
      await js(`[...document.querySelectorAll('[role=treeitem]')].find((e) => e.textContent.includes('ZHASKA.md')).click()`)
      const until = async (cond, ms = 8000) => {
        const t0 = Date.now()
        while (Date.now() - t0 < ms) {
          if (await js(cond)) return true
          await wait(150)
        }
        return false
      }
      await until(`!!document.querySelector('.monaco-editor .view-lines')`)
      const mod = process.platform === 'darwin' ? 'meta' : 'control'
      let focused = false
      for (let i = 0; i < 6 && !focused; i++) {
        win.show()
        win.focus()
        win.webContents.focus()
        // Clic real en la primera línea: Monaco enfoca su entrada (EditContext o textarea según la versión)
        const box = await js(`(() => { const r = document.querySelector('.monaco-editor .view-lines').getBoundingClientRect(); return { x: Math.round(r.left + 4), y: Math.round(r.top + 6) } })()`)
        win.webContents.sendInputEvent({ type: 'mouseDown', x: box.x, y: box.y, button: 'left', clickCount: 1 })
        win.webContents.sendInputEvent({ type: 'mouseUp', x: box.x, y: box.y, button: 'left', clickCount: 1 })
        focused = await until(`!!document.activeElement?.closest('.monaco-editor')`, 1000)
      }
      check('el editor recibe el foco', focused)
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: process.platform === 'darwin' ? 'Up' : 'Home', modifiers: [mod] })
      await wait(100)
      await win.webContents.insertText('Editado desde ZHASKA\n')
      check('escribir en el editor', await until(`document.querySelector('.monaco-editor .view-lines').innerText.replace(/\\u00a0/g, ' ').includes('Editado desde ZHASKA')`, 3000))
      check('pestaña marcada con cambios sin guardar', await until(`!!document.querySelector('[role=tab][aria-selected=true] .bg-fg-2')`, 3000))
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'S', modifiers: [mod] })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'S', modifiers: [mod] })
      await until(`!document.querySelector('[role=tab][aria-selected=true] .bg-fg-2')`, 3000)
      const saved = fs.readFileSync(path.join(root, 'ZHASKA.md'), 'utf8')
      check('editar y guardar desde el editor', saved.startsWith('Editado desde ZHASKA') && saved.includes('Proyecto de la prueba de humo'))

      // ── Fase 7: terminal real desde la ventana ──
      step('probando la terminal')
      await js(`window.__term = ''; window.zhaska.on('terminal.data', (e) => { window.__term += e.data }); true`)
      const term = await invoke('terminal.create', { projectId: pid, cols: 100, rows: 30 })
      await wait(900)
      await invoke('terminal.write', { id: term.data.id, data: process.platform === 'win32' ? 'echo "ZH-$(6*7)"\r' : 'echo "ZH-$((6*7))"\r' })
      let termOk = false
      for (let i = 0; i < 60 && !termOk; i++) {
        await wait(100)
        termOk = await js(`window.__term.includes('ZH-42')`)
      }
      check('terminal real: ejecuta comandos en el proyecto', term.ok && termOk, term.ok ? term.data.shell : term.error.message)
      await invoke('terminal.kill', { id: term.data.id })

      // ── Fase 8: adjuntos (almacén local, extracción en el worker, ZIP seguro, validación al enviar) ──
      step('probando los adjuntos')
      const upload = (name, buf) => js(`window.zhaska.invoke('attachments.upload', { name: ${JSON.stringify(name)}, data: Uint8Array.from(atob('${buf.toString('base64')}'), (c) => c.charCodeAt(0)) })`)
      const settle = async (id) => {
        for (let i = 0; i < 100; i++) {
          const g = await invoke('attachments.get', { ids: [id] })
          if (g.ok && g.data[0] && g.data[0].status !== 'processing') return g.data[0]
          await wait(200)
        }
        return null
      }
      const md = await upload('notas.md', Buffer.from('# Notas\nAñadir validación al formulario\n'))
      const mdDone = md.ok ? await settle(md.data.id) : null
      const mdPrev = mdDone ? await invoke('attachments.preview', { id: md.data.id }) : null
      check('adjunto de texto: se guarda fuera del proyecto y se extrae', !!mdPrev?.ok && mdDone.status === 'ready' && mdPrev.data.text.includes('Añadir validación') && !fs.readdirSync(path.join(projectsDir, 'prueba-humo')).includes('notas.md'), mdDone ? mdDone.status : md.ok ? 'sin terminar' : md.error.message)
      const zip = await upload('malicioso.zip', smokeZip([['app/main.py', 'print(1)'], ['../../fuera.txt', 'x'], ['/tmp/absoluto.txt', 'x']]))
      const zipDone = zip.ok ? await settle(zip.data.id) : null
      const escaped = findFile(process.env.ZHASKA_USER_DATA, 'fuera.txt') || findFile(process.env.ZHASKA_USER_DATA, 'absoluto.txt')
      check('ZIP malicioso: solo se extrae lo seguro', zipDone?.status === 'ready' && zipDone.meta.entries === 1 && zipDone.meta.rejected === 2 && !escaped, zipDone ? `${zipDone.meta.entries} extraído, ${zipDone.meta.rejected} rechazados` : 'sin terminar')
      const fake = await upload('falso.pdf', Buffer.from('esto no es un pdf'))
      const fakeDone = fake.ok ? await settle(fake.data.id) : null
      check('contenido que no coincide con la extensión → error claro', fakeDone?.status === 'error' && /no corresponde/.test(fakeDone.error ?? ''), fakeDone?.error ?? '')
      const sendBad = await invoke('chat.send', { conversationId: conv.data.id, text: 'mira', model: 'cualquiera', attachmentIds: [fake.data.id] })
      check('no se envía un mensaje con adjuntos con error', !sendBad.ok && sendBad.error.code === 'INVALID_INPUT', sendBad.ok ? 'se envió' : sendBad.error.message)
      await invoke('attachments.remove', { id: md.data.id })
      const gone = await invoke('attachments.get', { ids: [md.data.id] })
      check('quitar un adjunto antes de enviarlo', gone.ok && gone.data.length === 0)

      step('probando Ollama y el chat')
      // ── Ollama y chat real (solo si hay un servidor y un modelo en este equipo) ──
      const st = await invoke('ollama.status')
      check('supervisor de Ollama responde', st.ok, st.ok ? st.data.status.state : st.error.message)
      const hw = await invoke('system.hardware')
      check('detección de hardware', hw.ok && hw.data.ramGB > 1, hw.ok ? `${hw.data.accel} · ${hw.data.gpu ?? 'sin GPU'} · ${Math.round(hw.data.ramGB)} GB` : '')
      if (st.ok && st.data.status.state === 'connected') {
        const models = await invoke('models.list')
        const model = process.env.ZHASKA_SMOKE_MODEL || (models.ok && models.data[0]?.name)
        if (!model) skip('chat con el modelo', 'no hay modelos descargados')
        else {
          await js(`window.__chat = []; window.zhaska.on('chat.event', (e) => window.__chat.push(e)); true`)
          const conv2 = await invoke('conversations.create', { projectId: pid })
          const sent = await invoke('chat.send', { conversationId: conv2.data.id, text: 'Responde solo con la palabra: listo', model })
          check('enviar mensaje al modelo', sent.ok, sent.ok ? model : sent.error.message)
          const t0 = Date.now()
          let done = null
          while (Date.now() - t0 < 120_000 && !done) {
            await wait(300)
            done = await js(`window.__chat.find((e) => e.taskId === ${JSON.stringify(sent.data.taskId)} && ['done', 'error', 'cancelled'].includes(e.type)) || null`)
          }
          const deltas = await js(`window.__chat.filter((e) => e.taskId === ${JSON.stringify(sent.data.taskId)} && e.type === 'delta').length`)
          check('respuesta en streaming del modelo real', done?.type === 'done' && deltas > 0, done ? `${deltas} fragmentos · ${done.metrics?.tokensPerSec?.toFixed(1)} tok/s` : 'sin respuesta en 120 s')
          const stored = await invoke('messages.list', { conversationId: conv2.data.id })
          check('respuesta guardada con métricas y título automático', stored.ok && stored.data.length === 2 && !!stored.data[1].metrics && (await invoke('conversations.list', { projectId: pid })).data.some((c) => c.title.startsWith('Responde solo')))

          step('probando detener una respuesta')
          // Detener una respuesta a mitad
          const long = await invoke('chat.send', { conversationId: conv2.data.id, text: 'Escribe un texto largo de 300 palabras sobre la historia de la informática.', model })
          let first = false
          for (let i = 0; i < 400 && !first; i++) {
            await wait(100)
            first = await js(`window.__chat.some((e) => e.taskId === ${JSON.stringify(long.data.taskId)} && e.type === 'delta')`)
          }
          await invoke('chat.cancel', { taskId: long.data.taskId })
          let end = null
          for (let i = 0; i < 100 && !end; i++) {
            await wait(100)
            end = await js(`window.__chat.find((e) => e.taskId === ${JSON.stringify(long.data.taskId)} && ['done', 'error', 'cancelled'].includes(e.type)) || null`)
          }
          check('detener una respuesta en curso', end?.type === 'cancelled' && end.message?.blocks.some((b) => b.kind === 'notice'))

          step('probando el agente')
          // ── Agente (Fase 5): tarea real con herramientas ──
          await js(`window.__agent = []; window.zhaska.on('agent.event', (e) => window.__agent.push(e)); true`)
          const waitDone = async (taskId, onApproval) => {
            for (let i = 0; i < 1800; i++) {
              await wait(100)
              const evs = await js(`window.__agent.filter((e) => e.taskId === ${JSON.stringify(taskId)})`)
              const ask = evs.find((e) => e.kind === 'event' && e.event.type === 'approval.requested' && !e.__answered)
              if (ask && onApproval) {
                await js(`window.__agent.forEach((e) => { if (e.event?.requestId === ${JSON.stringify(ask.event.requestId)}) e.__answered = true }); true`)
                await invoke('agent.approve', { taskId, requestId: ask.event.requestId, decision: onApproval })
              }
              const done = evs.find((e) => e.kind === 'done')
              if (done) return { done, evs }
            }
            return { done: null, evs: [] }
          }
          const task = 'Crea un archivo llamado saludo.txt en la raíz del proyecto con el contenido: hola mundo. No hagas nada más.'
          await invoke('settings.set', { key: 'autonomy', value: 'balanced' })
          await invoke('settings.set', { key: 'permissions', value: { read: 'allow', write: 'ask', execute: 'ask', install: 'ask', internet: 'block' } })
          await invoke('settings.set', { key: 'autoVerify', value: false })
          const conv3 = await invoke('conversations.create', { projectId: pid })
          const a1 = await invoke('agent.start', { conversationId: conv3.data.id, text: task, model })
          const r1 = await waitDone(a1.data.taskId, 'allow_once')
          const steps1 = r1.evs.filter((e) => e.kind === 'event' && e.event.type === 'step.started').map((e) => e.event.tool)
          const created = fs.existsSync(path.join(root, 'saludo.txt')) && fs.readFileSync(path.join(root, 'saludo.txt'), 'utf8').toLowerCase().includes('hola mundo')
          check('agente: crea un archivo tras aprobarlo', created, `pasos: ${steps1.join(' → ') || 'ninguno'}`)
          const ch = await invoke('changes.list', { taskId: a1.data.taskId })
          check('agente: el cambio queda registrado', ch.ok && ch.data.some((c) => c.rel === 'saludo.txt' && c.kind === 'create'))
          const pend = await invoke('changes.pending', { projectId: pid })
          check('los cambios del agente quedan pendientes de revisar', !created || (pend.ok && pend.data.some((c) => c.rel === 'saludo.txt')))
          if (created) {
            const rej = await invoke('changes.reject', { taskId: a1.data.taskId })
            check('rechazar el cambio restaura el estado anterior', rej.ok && !fs.existsSync(path.join(root, 'saludo.txt')), rej.ok ? '' : rej.error.message)
            const pend2 = await invoke('changes.pending', { projectId: pid })
            check('tras rechazar ya no queda pendiente', pend2.ok && !pend2.data.some((c) => c.rel === 'saludo.txt'))
          }
          const conv4 = await invoke('conversations.create', { projectId: pid })
          const a2 = await invoke('agent.start', { conversationId: conv4.data.id, text: task.replace('saludo.txt', 'denegado.txt'), model })
          const r2 = await waitDone(a2.data.taskId, 'deny')
          const asked = r2.evs.some((e) => e.kind === 'event' && e.event.type === 'approval.requested')
          check('agente: si deniegas, no se crea nada', r2.done && !fs.existsSync(path.join(root, 'denegado.txt')), asked ? 'se pidió aprobación y se denegó' : 'el modelo no llegó a pedir escribir')

          step('probando la reconstrucción de la actividad')
          // ── Fase 6: actividad guardada y reconstruida tras recargar ──
          const act = await invoke('activity.task', { taskId: a2.data.taskId })
          const stepIds = act.ok ? act.data.events.filter((e) => e.type === 'step.started').map((e) => e.stepId) : []
          check('la actividad queda guardada evento a evento', act.ok && act.data.events[0]?.type === 'task.started' && stepIds.length > 0, act.ok ? `${act.data.events.length} eventos` : act.error.message)
          win.webContents.reload()
          await within(new Promise((res) => win.webContents.once('did-finish-load', res)), 30_000, 'recargar la ventana')
          await wait(3500)
          const shown = await js(`[...document.querySelectorAll('[data-steps]')].flatMap((e) => e.dataset.steps.split(','))`)
          check('al recargar, el panel reconstruye la misma tarea', stepIds.length > 0 && stepIds.every((id) => shown.includes(id)), `${stepIds.filter((id) => shown.includes(id)).length}/${stepIds.length} pasos`)
        }
      } else skip('chat con el modelo', 'Ollama no está en ejecución')
    } catch (e) {
      check('sin excepciones', false, e.message)
    } finally {
      if (process.env.ZHASKA_SMOKE_SHOT) {
        try {
          fs.writeFileSync(process.env.ZHASKA_SMOKE_SHOT, (await within(win.webContents.capturePage(), 10_000, 'captura de pantalla')).toPNG())
        } catch (e) {
          console.log(`  (sin captura: ${e.message})`)
        }
      }
      const failed = results.filter((r) => !r.ok).length
      console.log(`\n${results.length - failed}/${results.length} comprobaciones superadas`)
      fs.rmSync(tmp, { recursive: true, force: true })
      app.exit(failed ? 1 : 0)
    }
  })
})

require(path.join(__dirname, '..', 'out', 'main', 'index.js'))
