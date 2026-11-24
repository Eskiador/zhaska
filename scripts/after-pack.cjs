/**
 * Paso afterPack de electron-builder: quita de app.asar.unpacked los binarios nativos de OTRAS plataformas
 * (al generar el instalador de Windows desde macOS se colarían los de macOS, y al revés: ~30 MB).
 * Los filtros de `files` no los excluyen porque electron-builder copia aparte las dependencias nativas.
 * Es seguro: en esa plataforma nunca se cargan, y la integridad del ASAR cubre el índice y lo empaquetado,
 * no los archivos desempaquetados.
 */
const fs = require('node:fs')
const path = require('node:path')

const ARCH = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName // darwin | win32 | linux
  const arch = ARCH[context.arch] ?? String(context.arch)
  const resources =
    platform === 'darwin' ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources') : path.join(context.appOutDir, 'resources')
  const modules = path.join(resources, 'app.asar.unpacked', 'node_modules')
  const removed = []
  const drop = (dir) => {
    fs.rmSync(dir, { recursive: true, force: true })
    removed.push(path.relative(modules, dir))
  }
  // node-pty: prebuilds/<plataforma>-<arquitectura>
  const prebuilds = path.join(modules, 'node-pty', 'prebuilds')
  if (fs.existsSync(prebuilds)) for (const d of fs.readdirSync(prebuilds)) if (d !== `${platform}-${arch}`) drop(path.join(prebuilds, d))
  // @napi-rs/canvas: paquetes canvas-<plataforma>-<arquitectura>[-variante]
  const napi = path.join(modules, '@napi-rs')
  if (fs.existsSync(napi)) for (const d of fs.readdirSync(napi)) if (d.startsWith('canvas-') && !d.startsWith(`canvas-${platform}-${arch}`)) drop(path.join(napi, d))
  if (removed.length) console.log(`  • afterPack: quitados binarios de otras plataformas: ${removed.join(', ')}`)
  // Sin el binario de esta plataforma, las miniaturas y el OCR de PDF escaneados no funcionarían: mejor fallar aquí
  if (fs.existsSync(napi) && !fs.readdirSync(napi).some((d) => d.startsWith(`canvas-${platform}-${arch}`))) {
    throw new Error(`Falta @napi-rs/canvas para ${platform}-${arch}. En macOS, para Windows: node scripts/ensure-win-deps.cjs`)
  }
}
