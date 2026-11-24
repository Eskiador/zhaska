/**
 * Montaje del vídeo de demostración: fotogramas (con su duración real o acelerada) + narración colocada en el
 * momento exacto de cada frase + fundidos + capítulos por escena. Salida: video/ZHASKA-demo.mp4 (1080p, 30 fps)
 * y video/ZHASKA-demo.srt (subtítulos aparte).
 *   node scripts/video/montar.mjs
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESCENAS } from './guion.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const work = path.join(root, 'video', 'trabajo')
const outMp4 = path.join(root, 'video', 'ZHASKA-demo.mp4')
const tl = JSON.parse(readFileSync(path.join(work, 'linea-de-tiempo.json'), 'utf8'))
const voz = JSON.parse(readFileSync(path.join(work, 'voz.json'), 'utf8'))
if (tl.error) console.warn(`Aviso: la grabación terminó con error (${tl.error}); se monta lo grabado.`)

// 1. Lista de fotogramas con su duración
const total = tl.frames.reduce((s, f) => s + f.dur, 0)
const lines = ['ffconcat version 1.0']
for (const f of tl.frames) lines.push(`file 'frames/${f.file}'`, `duration ${f.dur.toFixed(4)}`)
lines.push(`file 'frames/${tl.frames.at(-1).file}'`)
writeFileSync(path.join(work, 'fotogramas.ffconcat'), lines.join('\n'))

// 2. Capítulos (primera frase de cada escena) y subtítulos SRT
const sceneOf = (key) => ESCENAS.find((e) => key.startsWith(`${e.id}.`))
const chapters = []
for (const b of tl.beats) {
  const s = sceneOf(b.key)
  if (s && !chapters.some((c) => c.id === s.id)) chapters.push({ id: s.id, title: s.titulo === 'ZHASKA' ? (s.id === 'portada' ? 'Introducción' : 'Cierre') : s.titulo, start: Math.max(0, b.start - 0.3) })
}
const meta = [';FFMETADATA1', 'title=ZHASKA · recorrido completo', 'artist=ZHASKA', 'comment=Demostración grabada con la app real. Datos de una empresa ficticia.']
chapters.forEach((c, i) => {
  const end = i + 1 < chapters.length ? chapters[i + 1].start : total
  meta.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${Math.round(c.start * 1000)}`, `END=${Math.round(end * 1000)}`, `title=${c.title}`)
})
writeFileSync(path.join(work, 'capitulos.txt'), meta.join('\n'))

const ts = (t) => {
  const ms = Math.round(t * 1000)
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`
}
const srt = []
let n = 1
for (const b of tl.beats) {
  const sentences = voz[b.key].text.match(/[^.!?:]+[.!?:]+["»]?|[^.!?:]+$/g).map((x) => x.trim()).filter(Boolean)
  const chars = sentences.reduce((s, x) => s + x.length, 0)
  let t = b.start
  for (const x of sentences) {
    const d = (x.length / chars) * b.dur
    srt.push(String(n++), `${ts(t)} --> ${ts(t + d)}`, x, '')
    t += d
  }
}
writeFileSync(outMp4.replace(/\.mp4$/, '.srt'), srt.join('\n'))

// 3. Narración: cada frase en su momento
const audioInputs = tl.beats.flatMap((b) => ['-i', voz[b.key].file])
const delays = tl.beats.map((b, i) => `[${i + 2}:a]adelay=delays=${Math.round(b.start * 1000)}:all=1[a${i}]`)
const mix = `${tl.beats.map((_, i) => `[a${i}]`).join('')}amix=inputs=${tl.beats.length}:normalize=0:dropout_transition=0,apad=whole_dur=${total.toFixed(2)},atrim=0:${total.toFixed(2)},afade=t=in:d=0.4,afade=t=out:st=${(total - 1.2).toFixed(2)}:d=1.2,loudnorm=I=-16:TP=-1.5:LRA=11[aout]`
const video = `[0:v]fps=30,scale=1920:1080:flags=lanczos,format=yuv420p,fade=t=in:d=0.8,fade=t=out:st=${(total - 1.2).toFixed(2)}:d=1.2[vout]`

const args = [
  '-y',
  '-loglevel',
  'error',
  '-stats',
  '-f',
  'concat',
  '-safe',
  '0',
  '-i',
  path.join(work, 'fotogramas.ffconcat'),
  '-f',
  'ffmetadata',
  '-i',
  path.join(work, 'capitulos.txt'),
  ...audioInputs,
  '-filter_complex',
  [video, ...delays, mix].join(';'),
  '-map',
  '[vout]',
  '-map',
  '[aout]',
  '-map_metadata',
  '1',
  '-map_chapters',
  '1',
  '-c:v',
  'libx264',
  '-preset',
  'slow',
  '-crf',
  '20',
  '-tune',
  'stillimage',
  '-c:a',
  'aac',
  '-b:a',
  '160k',
  '-ar',
  '48000',
  '-movflags',
  '+faststart',
  outMp4,
]
console.log(`Montando ${tl.frames.length} fotogramas (${(total / 60).toFixed(1)} min), ${tl.beats.length} frases y ${chapters.length} capítulos…`)
execFileSync('ffmpeg', args, { cwd: work, stdio: 'inherit' })
const info = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size', '-of', 'csv=p=0', outMp4], { encoding: 'utf8' }).trim()
console.log(`Listo: ${outMp4} (${info})`)
console.log(chapters.map((c) => `${ts(c.start).slice(3, 8)}  ${c.title}`).join('\n'))
