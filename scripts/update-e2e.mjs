/**
 * Prueba de actualización de vX a vX+1 (criterio de salida de la Fase 10): npm run test:update
 *  1. Compila dos versiones (0.1.0 y 0.1.1) con un canal de actualizaciones local (provider «generic»).
 *  2. Arranca la 0.1.0 empaquetada, comprueba todo lo que depende del empaquetado, busca la actualización en el
 *     canal y la descarga verificando su sha512 (scripts/package-e2e.mjs --feed).
 *  3. Arranca la 0.1.1 sobre los MISMOS datos, como tras instalar la actualización, y comprueba que se conserva todo.
 * En macOS la instalación final la haría Squirrel.Mac, que exige apps firmadas; el producto es para Windows,
 * donde el instalador NSIS se aplica sin firma (ver docs/WINDOWS.md para probarlo allí de punta a punta).
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
// --win: prepara desde macOS los dos instaladores de Windows para probar la actualización en el PC (docs/WINDOWS.md)
const forWindows = process.argv.includes('--win')
const win = process.platform === 'win32' || forWindows
// En Windows npx es un .cmd y necesita la consola; entonces las rutas con espacios van entre comillas
const run = (cmd, args) => {
  const shell = process.platform === 'win32' && cmd === 'npx'
  execFileSync(cmd, shell ? args.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : args, { cwd: root, stdio: 'inherit', shell })
}
const feed = 'http://127.0.0.1:45789/'
const v1 = path.join(root, 'dist', 'e2e-0.1.0')
const v2 = path.join(root, 'dist', 'e2e-0.1.1')
rmSync(v1, { recursive: true, force: true })
rmSync(v2, { recursive: true, force: true })

run('npx', ['electron-vite', 'build'])
if (forWindows && process.platform !== 'win32') run('node', [path.join(root, 'scripts', 'ensure-win-deps.cjs')])
// Configuración de prueba: la del repositorio con el canal local en lugar de GitHub Releases
const build = (version, out, targets) => {
  mkdirSync(out, { recursive: true })
  const config = path.join(out, 'e2e-config.json')
  writeFileSync(config, JSON.stringify({ extends: path.join(root, 'electron-builder.yml'), publish: [{ provider: 'generic', url: feed }], extraMetadata: { version }, directories: { output: out, buildResources: path.join(root, 'build') } }, null, 2))
  // Los tipos de paquete van justo detrás de la plataforma (--win nsis --x64)
  run('npx', ['electron-builder', ...(win ? ['--win', ...targets, '--x64'] : ['--mac', ...targets]), '--publish', 'never', '--config', config])
}
// app-update.yml (el canal) solo se escribe al generar un paquete actualizable: zip en macOS, instalador en Windows
build('0.1.0', v1, win ? ['nsis'] : ['zip'])
// La nueva versión, como se publicaría: instalador/zip + latest*.yml con su sha512
build('0.1.1', v2, win ? ['nsis'] : ['zip'])

if (forWindows && process.platform !== 'win32') {
  const v2Files = ['latest.yml', 'ZHASKA-Setup-0.1.1.exe', 'ZHASKA-Setup-0.1.1.exe.blockmap'].map((f) => path.join(v2, f))
  console.log(`\nInstaladores de prueba listos:\n  Instala en el PC: ${path.join(v1, 'ZHASKA-Setup-0.1.0.exe')}\n  Copia al PC, en una misma carpeta, y sírvela con scripts\\serve-updates.ps1:\n${v2Files.map((f) => `    ${f}`).join('\n')}\nSigue docs/WINDOWS.md, apartado «Actualización».`)
  process.exit(0)
}
const app = (dir) => (win ? path.join(dir, 'win-unpacked', 'ZHASKA.exe') : path.join(dir, `mac-${process.arch}`, 'ZHASKA.app'))
run('node', [path.join(root, 'scripts', 'package-e2e.mjs'), '--app', app(v1), '--upgrade', app(v2), '--feed', v2])
