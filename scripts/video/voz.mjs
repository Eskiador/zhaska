/**
 * Narración del vídeo con la voz «Mónica» de macOS (español de España), en local: `say` + ffmpeg.
 * Genera video/trabajo/voz/<beat>.wav y video/trabajo/voz.json con la duración de cada frase.
 *   node scripts/video/voz.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESCENAS } from './guion.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const dir = path.join(root, 'video', 'trabajo', 'voz')
mkdirSync(dir, { recursive: true })
const VOICE = process.env.ZHASKA_VOZ || 'Mónica'
const RATE = process.env.ZHASKA_VOZ_VELOCIDAD || '182'

const out = {}
for (const e of ESCENAS)
  for (const b of e.beats) {
    const key = `${e.id}.${b.id}`
    const aiff = path.join(dir, `${key}.aiff`)
    const wav = path.join(dir, `${key}.wav`)
    // «ZHASKA» se pronuncia «Zaska» (la voz lo deletrearía); los subtítulos mantienen el nombre escrito
    execFileSync('say', ['-v', VOICE, '-r', RATE, '-o', aiff, b.texto.replace(/ZHASKA/g, 'Zaska')])
    // 48 kHz estéreo, un poco de margen al final
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', aiff, '-af', 'apad=pad_dur=0.25', '-ar', '48000', '-ac', '2', wav])
    const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', wav], { encoding: 'utf8' }).trim())
    out[key] = { file: wav, duration: dur, text: b.texto }
    console.log(`${dur.toFixed(1).padStart(5)} s  ${key}`)
  }
writeFileSync(path.join(root, 'video', 'trabajo', 'voz.json'), JSON.stringify(out, null, 1))
const total = Object.values(out).reduce((s, b) => s + b.duration, 0)
console.log(`Total de narración: ${(total / 60).toFixed(1)} min`)
