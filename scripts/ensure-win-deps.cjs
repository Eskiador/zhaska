/**
 * Antes de generar el instalador de Windows desde macOS o Linux (npm run dist:win).
 * npm solo instala los binarios nativos opcionales de la plataforma actual; @napi-rs/canvas (miniaturas y OCR
 * de PDF escaneados) necesita su paquete para Windows x64. Se descarga del registro de npm con `npm pack`,
 * en la MISMA versión que el paquete principal, y se coloca en node_modules (sin tocar package.json ni el lock).
 * node-pty no lo necesita: trae sus binarios precompilados para Windows dentro del paquete.
 * En Windows (o en el CI windows-latest) no hace nada: npm ya lo instaló.
 */
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.join(__dirname, '..')
const pkg = '@napi-rs/canvas-win32-x64-msvc'
const dest = path.join(root, 'node_modules', '@napi-rs', 'canvas-win32-x64-msvc')
const version = require(path.join(root, 'node_modules', '@napi-rs', 'canvas', 'package.json')).version

if (process.platform === 'win32') process.exit(0)
if (fs.existsSync(path.join(dest, 'package.json')) && require(path.join(dest, 'package.json')).version === version) {
  console.log(`${pkg}@${version} ya está preparado`)
  process.exit(0)
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zhaska-win-deps-'))
try {
  const file = execFileSync('npm', ['pack', `${pkg}@${version}`, '--silent', '--pack-destination', tmp], { encoding: 'utf8' }).trim().split('\n').pop()
  const extract = path.join(tmp, 'x')
  fs.mkdirSync(extract)
  execFileSync('tar', ['-xzf', path.join(tmp, file), '-C', extract])
  const meta = JSON.parse(fs.readFileSync(path.join(extract, 'package', 'package.json'), 'utf8'))
  if (meta.name !== pkg || meta.version !== version || !meta.os?.includes('win32')) throw new Error(`Paquete inesperado: ${meta.name}@${meta.version}`)
  fs.rmSync(dest, { recursive: true, force: true })
  fs.cpSync(path.join(extract, 'package'), dest, { recursive: true })
  console.log(`${pkg}@${version} preparado para el instalador de Windows`)
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
