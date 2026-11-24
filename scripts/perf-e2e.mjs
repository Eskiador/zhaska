/**
 * Rendimiento de la app EMPAQUETADA (Fase 11): npm run test:perf
 *   - Arranque: desde que se lanza el ejecutable hasta que la interfaz está pintada y usable (objetivo < 2 s).
 *   - Memoria de todos los procesos de la app (sin Ollama), en reposo y con un proyecto grande abierto.
 *   - Proyecto de 50 000 archivos: abrirlo, desplegar una carpeta de 2 000 archivos, buscar un archivo por nombre
 *     y la CPU del vigilante de cambios en reposo.
 * node scripts/perf-e2e.mjs [--app <ejecutable>] [--json <archivo de resultados>]
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launch, until, wait } from './lib/app-driver.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}
const appPath = path.resolve(arg('--app') ?? (process.platform === 'darwin' ? path.join(root, 'dist', `mac-${process.arch}`, 'ZHASKA.app') : path.join(root, 'dist', 'win-unpacked', 'ZHASKA.exe')))
const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'zhaska-perf-')))
const env = { ZHASKA_USER_DATA: path.join(tmp, 'datos'), ZHASKA_PROJECTS_DIR: path.join(tmp, 'proyectos') }
mkdirSync(env.ZHASKA_PROJECTS_DIR, { recursive: true })

const results = {}
const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: !!ok })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const s = (ms) => `${(ms / 1000).toFixed(2)} s`

/** Arranca, espera a la interfaz lista y devuelve el tiempo desde el lanzamiento y los hitos de main. */
async function startup() {
  const app = await launch(appPath, env, { settle: 0 })
  const ready = await until(() => app.js(`Number(document.documentElement?.dataset.ready || 0)`), 30_000, 20)
  const m = (await app.invoke('app.metrics')).data
  return { app, ms: ready - app.spawnedAt, marks: m.startup }
}

async function memory(app, label) {
  await wait(4000)
  const m = (await app.invoke('app.metrics')).data
  results[`memoria_${label}`] = { totalMB: m.totalMB, procesos: m.processes.map((p) => `${p.name} ${p.memoryMB} MB`) }
  console.log(`  · memoria (${label}): ${m.totalMB} MB → ${m.processes.map((p) => `${p.name} ${p.memoryMB}`).join(' · ')}`)
  return m
}

try {
  console.log(`App: ${appPath}\n`)
  // ── 1. Arranque ──
  const first = await startup()
  console.log(`  · primer arranque (datos nuevos, crea la base de datos): ${s(first.ms)} · hitos de main: ${JSON.stringify(first.marks)}`)
  await first.app.invoke('settings.set', { key: 'onboardingDone', value: true })
  await memory(first.app, 'reposo')
  await first.app.quit()
  const warm = []
  for (let i = 0; i < 3; i++) {
    const r = await startup()
    warm.push(r.ms)
    if (i === 2) results.hitos = r.marks
    await r.app.quit()
  }
  results.arranque_ms = { primero: first.ms, siguientes: warm, mediana: median(warm) }
  check('arranque en menos de 2 s (interfaz pintada y usable)', median(warm) < 2000, `mediana ${s(median(warm))} (${warm.map(s).join(', ')}) · primero ${s(first.ms)}`)

  // ── 2. Proyecto de 50 000 archivos ──
  const app = (await startup()).app
  const created = await app.invoke('projects.create', { name: 'grande', parentDir: env.ZHASKA_PROJECTS_DIR, gitInit: false, createGuide: false })
  const p = created.data
  await app.invoke('projects.close', { id: p.id })
  const t0 = Date.now()
  let n = 0
  for (let a = 0; a < 100; a++)
    for (let b = 0; b < 10; b++) {
      const dir = path.join(p.rootPath, 'src', `modulo${a}`, `parte${b}`)
      mkdirSync(dir, { recursive: true })
      for (let c = 0; c < 48; c++, n++) writeFileSync(path.join(dir, `archivo${c}.ts`), `export const v${c} = ${c}\n`)
    }
  mkdirSync(path.join(p.rootPath, 'recursos'))
  for (let c = 0; c < 2000; c++, n++) writeFileSync(path.join(p.rootPath, 'recursos', `imagen-${String(c).padStart(4, '0')}.svg`), '<svg/>')
  writeFileSync(path.join(p.rootPath, 'src', 'modulo73', 'parte4', 'facturacion-especial.ts'), 'export {}\n')
  n++
  console.log(`  · proyecto de prueba: ${n.toLocaleString('es-ES')} archivos (${s(Date.now() - t0)} en generarlo)`)
  results.archivos = n

  // Abrir: igual que al arrancar con «reabrir el último proyecto»
  await app.invoke('settings.set', { key: 'lastProjectId', value: p.id })
  await app.invoke('settings.set', { key: 'openLastProject', value: true })
  await app.js(`delete document.documentElement.dataset.ready; true`)
  const tOpen = Date.now()
  await app.send('Page.reload', {})
  const opened = await until(() => app.js(`Number(document.documentElement?.dataset.ready || 0) && document.querySelectorAll('[role=treeitem]').length`), 30_000, 20)
  results.abrir_ms = Date.now() - tOpen
  check('abrir el proyecto de 50 000 archivos', opened && results.abrir_ms < 3000, `${s(results.abrir_ms)} hasta ver el explorador`)

  // Desplegar una carpeta de 2 000 archivos en el explorador
  const expand = await app.js(`(async () => {
    const row = [...document.querySelectorAll('[role=treeitem]')].find((e) => e.textContent.trim().startsWith('recursos'))
    if (!row) return -1
    const t = performance.now()
    row.click()
    for (let i = 0; i < 600; i++) {
      await new Promise((r) => requestAnimationFrame(r))
      if ([...document.querySelectorAll('[role=treeitem]')].some((e) => e.textContent.includes('imagen-00'))) return performance.now() - t
    }
    return -2
  })()`)
  results.desplegar_ms = Math.round(expand)
  const rows = await app.js(`document.querySelectorAll('[role=treeitem]').length`)
  check('desplegar una carpeta con 2 000 archivos', expand > 0 && expand < 500, `${Math.round(expand)} ms · ${rows} filas en el DOM`)

  // Buscar un archivo por nombre en todo el proyecto (paleta de comandos)
  const tFind = Date.now()
  const found = await app.invoke('fs.findFiles', { projectId: p.id, query: 'facturacion', limit: 20 })
  results.buscar_ms = Date.now() - tFind
  check('buscar un archivo por nombre entre 50 000', found.ok && found.data.files.some((f) => f.endsWith('facturacion-especial.ts')) && results.buscar_ms < 1000, found.ok ? `${results.buscar_ms} ms · ${found.data.total.toLocaleString('es-ES')} archivos indexados` : found.error.message)
  const tFind2 = Date.now()
  await app.invoke('fs.findFiles', { projectId: p.id, query: 'archivo47', limit: 20 })
  results.buscar_otra_ms = Date.now() - tFind2

  // CPU en reposo con el proyecto abierto (vigilante de cambios incluido)
  await wait(3000)
  const m1 = (await app.invoke('app.metrics')).data
  await wait(5000)
  const m2 = (await app.invoke('app.metrics')).data
  const cpu = m2.processes.reduce((a, x) => a + x.cpu, 0)
  results.cpu_reposo = cpu
  check('CPU en reposo con el proyecto abierto', cpu < 10, `${cpu.toFixed(1)} % (suma de procesos)`)
  void m1
  const mem = await memory(app, 'proyecto_grande')
  check('memoria con el proyecto grande abierto', mem.totalMB < 800, `${mem.totalMB} MB en total (sin Ollama)`)
  await app.quit()
} catch (e) {
  check('sin excepciones', false, e.message)
} finally {
  try {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
  } catch {
    /* en Windows puede quedar algún archivo abierto: el sistema limpia la carpeta temporal */
  }
}
const out = arg('--json')
if (out) writeFileSync(out, JSON.stringify(results, null, 2))
const failed = checks.filter((c) => !c.ok).length
console.log(`\n${checks.length - failed}/${checks.length} comprobaciones superadas`)
process.exit(failed ? 1 : 0)
