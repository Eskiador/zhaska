/**
 * Prueba de la app EMPAQUETADA (Fase 10): el ejecutable real que recibe el usuario, con ASAR, fusibles y
 * módulos nativos fuera del ASAR. Como los fusibles impiden inyectarle código, se maneja desde fuera con el
 * protocolo de depuración de Chromium (--remote-debugging-port) y se comprueba lo que hace la interfaz real.
 *
 *   node scripts/package-e2e.mjs [--app <ejecutable>] [--upgrade <ejecutable v2>] [--feed <carpeta>]
 *
 *  --app      por defecto dist/mac-arm64/ZHASKA.app (macOS) o dist/win-unpacked/ZHASKA.exe (Windows)
 *  --upgrade  después, arranca esta otra versión con los MISMOS datos (lo que hace el instalador al actualizar)
 *  --feed     sirve esa carpeta en http://127.0.0.1:45789/ y prueba buscar y descargar la actualización
 *             (la app debe estar compilada con publish.provider=generic apuntando a esa dirección)
 * Variables: ZHASKA_E2E_MODEL (por defecto gemma4:12b-it-qat) para la tarea del agente si Ollama está en marcha.
 */
import { createServer } from 'node:http'
import { createReadStream, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FuseState, FuseV1Options, getCurrentFuseWire } from '@electron/fuses'
import { launch as launchApp, until, wait } from './lib/app-driver.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}
const defaultApp = process.platform === 'darwin' ? path.join(root, 'dist', `mac-${process.arch}`, 'ZHASKA.app') : path.join(root, 'dist', 'win-unpacked', 'ZHASKA.exe')
const appPath = path.resolve(arg('--app') ?? defaultApp)
const upgradePath = arg('--upgrade') ? path.resolve(arg('--upgrade')) : null
const feedDir = arg('--feed') ? path.resolve(arg('--feed')) : null
const MODEL = process.env.ZHASKA_E2E_MODEL || 'gemma4:12b-it-qat'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}
const info = (msg) => console.log(`  · ${msg}`)

const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'zhaska-pkg-')))
const userData = path.join(tmp, 'datos')
const projectsDir = path.join(tmp, 'proyectos')
mkdirSync(projectsDir)

// ── 1. Fusibles e integridad (sin arrancar) ──
function checkBinary(p) {
  const wire = getCurrentFuseWire(p)
  return wire.then((w) => {
    const is = (opt, state) => w[opt] === state
    check(
      'fusibles de Electron aplicados',
      is(FuseV1Options.RunAsNode, FuseState.DISABLE) &&
        is(FuseV1Options.EnableNodeOptionsEnvironmentVariable, FuseState.DISABLE) &&
        is(FuseV1Options.EnableNodeCliInspectArguments, FuseState.DISABLE) &&
        is(FuseV1Options.EnableEmbeddedAsarIntegrityValidation, FuseState.ENABLE) &&
        is(FuseV1Options.OnlyLoadAppFromAsar, FuseState.ENABLE),
      'RunAsNode, NODE_OPTIONS e --inspect desactivados; integridad del ASAR y solo ASAR activados',
    )
    if (p.endsWith('.app')) {
      const plist = readFileSync(path.join(p, 'Contents', 'Info.plist'), 'utf8')
      check('hash de integridad del ASAR en Info.plist', /ElectronAsarIntegrity[\s\S]*app\.asar[\s\S]*SHA256/.test(plist))
    }
    const res = p.endsWith('.app') ? path.join(p, 'Contents', 'Resources') : path.join(path.dirname(p), 'resources')
    const unpacked = path.join(res, 'app.asar.unpacked', 'node_modules')
    check('módulos nativos y OCR fuera del ASAR', ['node-pty', '@napi-rs', 'tesseract.js-core'].every((m) => existsSync(path.join(unpacked, m))))
    return res
  })
}

const launch = (p) => launchApp(p, { ZHASKA_USER_DATA: userData, ZHASKA_PROJECTS_DIR: projectsDir })

// Servidor local de actualizaciones (canal «generic» de electron-updater)
function serveFeed(dir) {
  const server = createServer((req, res) => {
    const file = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname))
    if (!file.startsWith(dir) || !existsSync(file) || statSync(file).isDirectory()) return res.writeHead(404).end()
    res.writeHead(200, { 'Content-Length': statSync(file).size })
    createReadStream(file).pipe(res)
  })
  return new Promise((r) => server.listen(45789, '127.0.0.1', () => r(server)))
}

const { makeTextPdf, makeScannedPdf, renderTextImage, makeDocx, makeXlsx } = await import('../tests/fixtures/attachments.ts')

let server = null
try {
  console.log(`App: ${appPath}`)
  await checkBinary(appPath)
  if (feedDir) server = await serveFeed(feedDir)

  // ── 2. Primera versión: todo lo que depende del empaquetado ──
  console.log('\nPrimer arranque')
  const a = await launch(appPath)
  const appInfo = (await a.invoke('app.info')).data
  check('arranca empaquetada y abre la interfaz', appInfo?.packaged === true, `v${appInfo?.version} · Electron ${appInfo?.electron} · SQLite ${appInfo?.sqlite}`)
  check('la interfaz no tiene acceso a Node', await a.js(`typeof require === 'undefined' && typeof process === 'undefined'`))
  await a.invoke('settings.set', { key: 'onboardingDone', value: true })
  await a.invoke('settings.set', { key: 'temperature', value: 0.35 })

  const up = (await a.invoke('update.status')).data
  info(`actualizaciones: ${up.state}${up.message ? ` (${up.message})` : ''}`)

  // Adjuntos: OCR (tesseract fuera del ASAR), PDF (pdfjs), PDF escaneado (canvas + OCR), Word, Excel; extracción en el worker
  const files = [
    ['captura.png', renderTextImage(['Error: puerto 3000 ocupado'])],
    ['informe.pdf', makeTextPdf(['Informe trimestral de ventas'])],
    ['escaneado.pdf', makeScannedPdf([['FACTURA 2026-118', 'Total: 1.250 EUR']])],
    ['notas.docx', makeDocx(['Reunión del lunes con el cliente'])],
    ['ventas.xlsx', makeXlsx([{ name: 'Enero', rows: [['Mes', 'Importe'], ['Enero', 4321]] }])],
  ]
  const ids = []
  for (const [name, data] of files) {
    const b64 = Buffer.from(data).toString('base64')
    const r = await a.js(`window.zhaska.invoke('attachments.upload', { name: ${JSON.stringify(name)}, data: Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0)) })`)
    if (r.ok) ids.push(r.data.id)
    else check(`subir ${name}`, false, r.error.message)
  }
  const done = await until(async () => {
    const rows = (await a.invoke('attachments.get', { ids })).data ?? []
    return rows.length === ids.length && rows.every((x) => x.status === 'ready' || x.status === 'error') ? rows : null
  }, 120_000, 800)
  for (const row of done ?? []) {
    const prev = (await a.invoke('attachments.preview', { id: row.id })).data
    const text = prev?.text ?? ''
    const expect = { 'captura.png': /puerto 3000/i, 'informe.pdf': /trimestral/i, 'escaneado.pdf': /FACTURA/i, 'notas.docx': /Reunión del lunes/i, 'ventas.xlsx': /4321/ }[row.name]
    check(`adjunto ${row.name} procesado en la app instalada`, row.status === 'ready' && expect.test(text), row.status === 'ready' ? text.replace(/\s+/g, ' ').slice(0, 70) : row.error)
  }
  if (!done) check('adjuntos procesados', false, 'tiempo agotado')

  // Proyecto en la carpeta de proyectos (aislada) + terminal real (node-pty fuera del ASAR)
  const proj = await a.invoke('projects.create', { name: 'tienda', parentDir: projectsDir, gitInit: false, createGuide: true })
  check('crear un proyecto', proj.ok, proj.ok ? proj.data.rootPath : proj.error.message)
  const pid = proj.data?.id
  await a.js(`window.__term = ''; window.zhaska.on('terminal.data', (p) => { window.__term += p.data }); true`)
  const term = await a.invoke('terminal.create', { projectId: pid, cols: 100, rows: 20 })
  if (term.ok) {
    await wait(1500)
    await a.invoke('terminal.write', { id: term.data.id, data: process.platform === 'win32' ? 'echo zhaska-pty-ok\r' : 'echo zhaska-pty-ok\n' })
    const seen = await until(() => a.js(`window.__term.split('zhaska-pty-ok').length > 2`), 15_000)
    check('terminal real (node-pty) en la app instalada', seen, term.data.shell)
    await a.invoke('terminal.kill', { id: term.data.id })
  } else check('terminal real (node-pty) en la app instalada', false, term.error.message)

  // Agent Host (utilityProcess desde el ASAR) + Ollama: una tarea real con herramientas
  const ol = (await a.invoke('ollama.status')).data
  const models = ol?.status.state === 'connected' ? ((await a.invoke('models.list')).data ?? []) : []
  if (models.some((m) => m.name === MODEL)) {
    await a.invoke('settings.set', { key: 'autonomy', value: 'autonomous' })
    await a.invoke('settings.set', { key: 'permissions', value: { read: 'allow', write: 'allow', execute: 'allow', install: 'ask', internet: 'block' } })
    await a.invoke('settings.set', { key: 'autoVerify', value: false })
    const conv = await a.invoke('conversations.create', { projectId: pid })
    const t0 = Date.now()
    const task = await a.invoke('agent.start', { conversationId: conv.data.id, text: 'Crea un archivo llamado hola.txt en la raíz del proyecto con el contenido: hola desde ZHASKA. No hagas nada más.', model: MODEL })
    const act = await until(async () => {
      const r = (await a.invoke('activity.latest', { conversationId: conv.data.id })).data
      return r && ['completed', 'failed', 'cancelled'].includes(r.status) ? r : null
    }, 300_000, 1000)
    const file = path.join(proj.data.rootPath, 'hola.txt')
    const ok = task.ok && act?.status === 'completed' && existsSync(file) && /hola desde zhaska/i.test(readFileSync(file, 'utf8'))
    check('el agente trabaja en la app instalada (Agent Host + Ollama + herramientas)', ok, `${MODEL} · ${((Date.now() - t0) / 1000).toFixed(0)} s · ${act?.events.filter((e) => e.type === 'step.started').map((e) => e.tool).join(' → ') ?? act?.status}`)
  } else info(`agente con modelo: omitido (${ol?.status.state === 'connected' ? `falta ${MODEL}` : 'Ollama no está en marcha'})`)

  const b = await a.invoke('backups.create')
  check('copia de seguridad', b.ok)

  // Actualización por el canal (si se pidió): buscar y descargar con verificación sha512
  if (feedDir) {
    const st = (await a.invoke('update.check')).data
    const avail = await until(async () => {
      const s = (await a.invoke('update.status')).data
      return ['available', 'not-available', 'error'].includes(s.state) ? s : null
    }, 30_000)
    check('busca la actualización en el canal y la encuentra', avail?.state === 'available', `${st.current} → ${avail?.version ?? avail?.error ?? avail?.state}`)
    if (avail?.state === 'available') {
      await a.invoke('update.download')
      const fin = await until(async () => {
        const s = (await a.invoke('update.status')).data
        return ['downloaded', 'error'].includes(s.state) ? s : null
      }, 180_000, 1000)
      if (process.platform === 'darwin' && fin?.state === 'error' && /firmadas/.test(fin.error ?? ''))
        info(`descarga verificada; macOS se niega a instalar apps sin firma (esperado: el producto es para Windows, donde no hace falta) — ${fin.error}`)
      else check('descarga la actualización y la verifica (sha512)', fin?.state === 'downloaded', fin?.error ?? fin?.state)
    }
  }
  await a.quit()

  // ── 3. Nueva versión sobre los mismos datos (lo que hace el instalador al actualizar) ──
  if (upgradePath) {
    console.log('\nArranque de la nueva versión con los mismos datos')
    await checkBinary(upgradePath)
    const n = await launch(upgradePath)
    const i2 = (await n.invoke('app.info')).data
    check('arranca la nueva versión y detecta la actualización', i2.updatedFrom === appInfo.version && i2.version !== appInfo.version, `${i2.updatedFrom} → ${i2.version}`)
    const settings = (await n.invoke('settings.getAll')).data
    const projects = (await n.invoke('projects.list')).data
    check('conserva ajustes y proyectos', settings.temperature === 0.35 && projects.some((p) => p.name === 'tienda'))
    const atts = (await n.invoke('attachments.get', { ids })).data ?? []
    check('conserva los adjuntos', atts.length === ids.length && atts.every((x) => x.status === 'ready'))
    const backups = (await n.invoke('backups.list')).data ?? []
    check('conserva las copias de seguridad', backups.some((x) => x.file === b.data?.file))
    await wait(500)
    check('avisa en la interfaz de que se actualizó', (await n.js('document.body.innerText')).includes('ZHASKA se actualizó'))
    await n.quit()
  }
} catch (e) {
  check('sin excepciones', false, e.message)
} finally {
  server?.close()
  try {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
  } catch {
    /* en Windows puede quedar algún archivo abierto: el sistema limpia la carpeta temporal */
  }
}
const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} comprobaciones superadas`)
process.exit(failed ? 1 : 0)
