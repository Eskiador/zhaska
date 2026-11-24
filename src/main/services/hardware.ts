import { execFile } from 'node:child_process'
import { statfs } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export interface HardwareInfo {
  gpu: string | null
  accel: 'cuda' | 'metal' | 'cpu'
  /** VRAM dedicada (NVIDIA) o memoria que la GPU puede usar (Apple, memoria unificada ≈ 2/3). */
  vramGB: number | null
  unified: boolean
  ramGB: number
  freeRamGB: number
  diskFreeGB: number | null
  modelsDir: string
}

const GB = 1024 ** 3

function run(cmd: string, args: string[], timeoutMs = 4000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => resolve(err ? null : stdout.trim()))
  })
}

export const ollamaModelsDir = () => process.env['OLLAMA_MODELS'] || path.join(os.homedir(), '.ollama', 'models')

/** Detección de GPU, memoria y disco sin dependencias (nvidia-smi si existe). */
export async function detectHardware(): Promise<HardwareInfo> {
  const ramGB = os.totalmem() / GB
  const modelsDir = ollamaModelsDir()
  let diskFreeGB: number | null = null
  for (const p of [modelsDir, os.homedir()]) {
    try {
      const s = await statfs(p)
      diskFreeGB = (s.bavail * s.bsize) / GB
      break
    } catch {
      /* la carpeta de modelos puede no existir todavía */
    }
  }
  const base = { ramGB, freeRamGB: os.freemem() / GB, diskFreeGB, modelsDir }

  if (process.platform === 'darwin' && process.arch === 'arm64') {
    const cpu = os.cpus()[0]?.model ?? 'Apple Silicon'
    return { ...base, gpu: cpu, accel: 'metal', vramGB: ramGB * 0.67, unified: true }
  }
  const smi = await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'])
  if (smi) {
    const [name, mem] = smi.split('\n')[0]!.split(',').map((s) => s.trim())
    return { ...base, gpu: name ?? 'NVIDIA', accel: 'cuda', vramGB: Number(mem) / 1024, unified: false }
  }
  return { ...base, gpu: null, accel: 'cpu', vramGB: null, unified: false }
}

/**
 * Requisitos del equipo (asistente inicial, ARCHITECTURE §11.1): Windows 10 22H2 (compilación 19045) o
 * Windows 11, x64 y RAM. macOS y Linux se aceptan como entornos de desarrollo.
 */
export function checkRequirements(platform: NodeJS.Platform = process.platform, release = os.release(), arch: string = process.arch, totalBytes = os.totalmem()) {
  const ramGB = Math.round((totalBytes / GB) * 10) / 10
  let osName = `${platform} ${release}`
  let osOk = true
  let osNote = ''
  if (platform === 'win32') {
    const build = Number(release.split('.')[2] ?? 0)
    osName = build >= 22000 ? `Windows 11 (compilación ${build})` : `Windows 10 (compilación ${build})`
    osOk = build >= 19045
    osNote = osOk ? '' : 'ZHASKA necesita Windows 10 22H2 (compilación 19045) o Windows 11. Actualiza Windows desde Windows Update.'
  } else if (platform === 'darwin') {
    osName = `macOS (Darwin ${release})`
    osNote = 'Entorno de desarrollo: el producto está pensado para Windows.'
  } else osNote = 'Entorno de desarrollo: el producto está pensado para Windows.'
  const archOk = arch === 'x64' || (platform === 'darwin' && arch === 'arm64')
  return {
    os: osName,
    osOk,
    osNote,
    arch,
    archOk,
    ramGB,
    ramOk: ramGB >= 15, // 16 GB nominales se ven como ~15,8
  }
}

/**
 * Node, Python y Git: no son necesarios para usar ZHASKA; solo se detectan e informan (§11.1, paso 7).
 * `run` ejecuta un comando en la shell del usuario (en macOS, con su PATH de inicio de sesión).
 */
export async function detectDevTools(run: (command: string) => Promise<string | null>): Promise<{ id: 'node' | 'python' | 'git'; label: string; version: string | null }[]> {
  const version = (out: string | null) => /(\d+\.\d+(?:\.\d+)?)/.exec(out ?? '')?.[1] ?? null
  const python = async () => {
    // En Windows, «python» puede ser el alias de la Microsoft Store (no instala nada, solo abre la tienda): se prueba antes «py»
    for (const cmd of process.platform === 'win32' ? ['py --version', 'python --version'] : ['python3 --version', 'python --version']) {
      const out = await run(cmd)
      if (out && /^Python \d/i.test(out.trim())) return version(out)
    }
    return null
  }
  const [node, git, py] = await Promise.all([run('node --version').then((o) => (o && /^v?\d/.test(o.trim()) ? version(o) : null)), run('git --version').then((o) => (o && /git version/i.test(o) ? version(o) : null)), python()])
  return [
    { id: 'node', label: 'Node.js', version: node },
    { id: 'python', label: 'Python', version: py },
    { id: 'git', label: 'Git', version: git },
  ]
}
