/**
 * Ajustes tras `npm install`.
 * node-pty 1.1.0 publica `spawn-helper` (macOS/Linux) sin permiso de ejecución y la terminal falla con
 * "posix_spawnp failed". Se le da permiso de ejecución. En Windows no hace nada.
 */
const fs = require('node:fs')
const path = require('node:path')

if (process.platform !== 'win32') {
  const roots = [path.join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds'), path.join(__dirname, '..', 'node_modules', 'node-pty', 'build', 'Release')]
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    const helpers = root.endsWith('prebuilds') ? fs.readdirSync(root).map((d) => path.join(root, d, 'spawn-helper')) : [path.join(root, 'spawn-helper')]
    for (const file of helpers) {
      if (fs.existsSync(file)) {
        fs.chmodSync(file, 0o755)
        console.log(`[postinstall] permiso de ejecución: ${path.relative(process.cwd(), file)}`)
      }
    }
  }
}
