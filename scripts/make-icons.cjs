/**
 * Genera los recursos de marca del instalador a partir del logotipo de la interfaz (Logo.tsx):
 *   build/icon.png              1024×1024 (electron-builder crea a partir de él el .ico de Windows y el .icns de macOS)
 *   build/installerSidebar.bmp  164×314 (páginas de bienvenida y final del instalador NSIS)
 *   build/uninstallerSidebar.bmp
 * Uso: node scripts/make-icons.cjs   (resultado determinista; los archivos se guardan en el repositorio)
 */
const fs = require('node:fs')
const path = require('node:path')
const { createCanvas } = require('@napi-rs/canvas')

const out = path.join(__dirname, '..', 'build')
fs.mkdirSync(out, { recursive: true })

/** Dibuja la marca (viewBox 24×24 de Logo.tsx) en un cuadrado de lado `s` en (x, y). */
function drawMark(ctx, x, y, s) {
  const k = s / 24
  const g = ctx.createLinearGradient(x, y, x + s, y + s)
  g.addColorStop(0, '#6A90FF')
  g.addColorStop(1, '#3B5BDB')
  ctx.beginPath()
  ctx.roundRect(x + 0.5 * k, y + 0.5 * k, 23 * k, 23 * k, 6 * k)
  ctx.fillStyle = g
  ctx.fill()
  ctx.lineWidth = Math.max(1, k)
  ctx.strokeStyle = 'rgba(255,255,255,0.14)'
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(x + 7.5 * k, y + 7.5 * k)
  ctx.lineTo(x + 16.5 * k, y + 7.5 * k)
  ctx.lineTo(x + 7.5 * k, y + 16.5 * k)
  ctx.lineTo(x + 16.5 * k, y + 16.5 * k)
  ctx.lineWidth = 2.2 * k
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = '#FFFFFF'
  ctx.stroke()
  ctx.beginPath()
  ctx.arc(x + 16.5 * k, y + 16.5 * k, 1.6 * k, 0, Math.PI * 2)
  ctx.fillStyle = '#C9BFFF'
  ctx.fill()
}

// Icono: margen del 9 % (en macOS los iconos no ocupan todo el lienzo; en Windows queda proporcionado)
const icon = createCanvas(1024, 1024)
{
  const ctx = icon.getContext('2d')
  const m = Math.round(1024 * 0.09)
  drawMark(ctx, m, m, 1024 - 2 * m)
}
fs.writeFileSync(path.join(out, 'icon.png'), icon.toBuffer('image/png'))

/** BMP de 24 bits (lo que exige NSIS), filas de abajo arriba y alineadas a 4 bytes. */
function toBmp(canvas) {
  const { width: w, height: h } = canvas
  const rgba = canvas.getContext('2d').getImageData(0, 0, w, h).data
  const row = Math.ceil((w * 3) / 4) * 4
  const size = 54 + row * h
  const b = Buffer.alloc(size)
  b.write('BM', 0)
  b.writeUInt32LE(size, 2)
  b.writeUInt32LE(54, 10)
  b.writeUInt32LE(40, 14)
  b.writeInt32LE(w, 18)
  b.writeInt32LE(h, 22)
  b.writeUInt16LE(1, 26)
  b.writeUInt16LE(24, 28)
  b.writeUInt32LE(row * h, 34)
  for (let yy = 0; yy < h; yy++) {
    const dst = 54 + (h - 1 - yy) * row
    for (let xx = 0; xx < w; xx++) {
      const s = (yy * w + xx) * 4
      b[dst + xx * 3] = rgba[s + 2]
      b[dst + xx * 3 + 1] = rgba[s + 1]
      b[dst + xx * 3 + 2] = rgba[s]
    }
  }
  return b
}

// Barra lateral del instalador: fondo de la app, marca, nombre y lema
function sidebar(subtitle) {
  const c = createCanvas(164, 314)
  const ctx = c.getContext('2d')
  const bg = ctx.createLinearGradient(0, 0, 0, 314)
  bg.addColorStop(0, '#11141C')
  bg.addColorStop(1, '#09090B')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, 164, 314)
  ctx.fillStyle = 'rgba(255,255,255,0.04)'
  for (let yy = 9; yy < 314; yy += 18) for (let xx = 9; xx < 164; xx += 18) ctx.fillRect(xx, yy, 1, 1)
  drawMark(ctx, 24, 40, 48)
  ctx.fillStyle = '#F4F4F6'
  ctx.font = '600 20px sans-serif'
  ctx.fillText('ZHASKA', 24, 120)
  ctx.fillStyle = '#9AA1B2'
  ctx.font = '12px sans-serif'
  const lines = subtitle
  lines.forEach((l, i) => ctx.fillText(l, 24, 146 + i * 17))
  ctx.fillStyle = '#5B6475'
  ctx.font = '10px sans-serif'
  ctx.fillText('IA local con Ollama', 24, 292)
  return toBmp(c)
}
fs.writeFileSync(path.join(out, 'installerSidebar.bmp'), sidebar(['Programa con IA', 'sin que tu código', 'salga de este equipo.']))
fs.writeFileSync(path.join(out, 'uninstallerSidebar.bmp'), sidebar(['Tus proyectos y', 'tus datos no se', 'borran al desinstalar.']))
console.log('Recursos generados en', out)
