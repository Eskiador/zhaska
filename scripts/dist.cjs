/**
 * Empaquetado local (npm run dist / dist:win). Los argumentos se pasan a electron-builder.
 * Si el proyecto aún no tiene repositorio de GitHub (decisión pendiente en ROADMAP), electron-builder no puede
 * escribir la información de actualizaciones (latest.yml) para GitHub Releases y falla al final. En ese caso se
 * empaqueta SIN canal de actualizaciones: el instalador funciona igual y la app indica «no configuradas».
 */
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const args = process.argv.slice(2)
let repo = null
try {
  repo = execFileSync('git', ['config', '--get', 'remote.origin.url'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
} catch {
  /* sin Git o sin remoto */
}
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
repo ||= typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url

let extra = []
if (!repo || !/github\.com/.test(repo)) {
  const config = path.join(root, 'dist', 'local-config.json')
  fs.mkdirSync(path.dirname(config), { recursive: true })
  fs.writeFileSync(config, JSON.stringify({ extends: path.join(root, 'electron-builder.yml'), publish: null, directories: { output: path.join(root, 'dist'), buildResources: path.join(root, 'build') } }, null, 2))
  extra = ['--config', config]
  console.log('Sin repositorio de GitHub: se empaqueta sin canal de actualizaciones (la app mostrará «no configuradas»).')
}
// En Windows npx es un .cmd y necesita la consola: las rutas con espacios van entre comillas
const shell = process.platform === 'win32'
const all = ['electron-builder', ...args, '--publish', 'never', ...extra].map((a) => (shell && /\s/.test(a) ? `"${a}"` : a))
execFileSync('npx', all, { cwd: root, stdio: 'inherit', shell })
