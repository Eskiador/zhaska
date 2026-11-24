/**
 * Prueba de restauración de punta a punta (npm run test:restore), criterio de salida de la Fase 9.
 * Lanza la app compilada tres veces sobre la misma carpeta de datos temporal:
 *   1. guarda una copia, cambia los datos y pide restaurar → la app se cierra para reiniciar
 *   2. arranca, aplica la restauración ANTES de abrir la base de datos y lo comprueba; exporta e importa
 *   3. arranca, aplica la importación y lo comprueba
 * Así se prueba el arranque real (src/main/index.ts → applyPending), no una simulación.
 */
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const electron = require('electron')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zhaska-restore-'))
const userData = path.join(tmp, 'userdata')
let failed = 0
let total = 0

for (const phase of ['1', '2', '3']) {
  const out = path.join(tmp, `fase-${phase}.json`)
  const r = spawnSync(electron, [path.join(__dirname, 'restore-app.cjs')], {
    env: { ...process.env, ZHASKA_USER_DATA: userData, ZHASKA_RESTORE_PHASE: phase, ZHASKA_RESTORE_OUT: out, ELECTRON_RENDERER_URL: '' },
    encoding: 'utf8',
    timeout: 180_000,
  })
  let res = { results: [] }
  try {
    res = JSON.parse(fs.readFileSync(out, 'utf8'))
  } catch {
    res.results.push({ name: `la fase ${phase} produjo resultados`, ok: false, detail: (r.stderr || r.stdout || '').slice(-400) })
  }
  console.log(`Fase ${phase}`)
  for (const c of res.results) {
    total++
    if (!c.ok) failed++
    console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`)
  }
  if (phase !== '3') {
    const relaunched = fs.existsSync(`${out}.relaunch`)
    total++
    if (!relaunched) failed++
    console.log(`  ${relaunched ? '✓' : '✗'} la app pidió reiniciarse`)
    if (!relaunched) break
  }
}

console.log(`\n${total - failed}/${total} comprobaciones superadas`)
try {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
} catch {
  /* en Windows puede quedar algún archivo abierto: el sistema limpia la carpeta temporal */
}
process.exit(failed ? 1 : 0)
