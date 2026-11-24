import { spawn, type ChildProcess } from 'node:child_process'
import os from 'node:os'

export interface RunOptions {
  cwd: string
  /** Comando completo para la shell, o programa + argumentos sin shell */
  command?: string
  file?: string
  args?: string[]
  shell: 'powershell' | 'cmd' | 'gitbash' | 'posix'
  timeoutMs: number
  signal?: AbortSignal
  onOutput?: (line: string) => void
}

export interface RunResult {
  exitCode: number | null
  output: string
  timedOut: boolean
  cancelled: boolean
  truncated: boolean
  durationMs: number
}

const MAX_OUTPUT = 200_000
/** Variables de entorno que nunca se pasan a los comandos del agente. */
const SECRET_ENV = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE|CREDENTIAL|SESSION)/i

export function filteredEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!SECRET_ENV.test(k)) env[k] = v
  env['CI'] = '1' // menos interactividad y colores en herramientas como npm o vitest
  env['FORCE_COLOR'] = '0'
  env['NO_COLOR'] = '1'
  return env
}

function shellCommand(shell: RunOptions['shell'], command: string): [string, string[]] {
  if (process.platform === 'win32') {
    if (shell === 'cmd') return ['cmd.exe', ['/d', '/s', '/c', command]]
    if (shell === 'gitbash') return ['bash.exe', ['-lc', command]]
    return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command]]
  }
  // Shell de inicio de sesión del usuario: así el PATH incluye Homebrew, nvm, etc.
  const sh = process.env['SHELL'] || '/bin/sh'
  return [sh, ['-lc', command]]
}

function killTree(child: ChildProcess) {
  if (!child.pid) return
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
  else {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      child.kill('SIGTERM')
    }
  }
}

/** Ejecuta un comando con tiempo límite, salida acotada (inicio + final) y cancelación del árbol de procesos. */
export function runCommand(opts: RunOptions): Promise<RunResult> {
  const started = Date.now()
  const [file, args] = opts.command !== undefined ? shellCommand(opts.shell, opts.command) : [opts.file!, opts.args ?? []]
  return new Promise((resolve) => {
    let output = ''
    let truncated = false
    let timedOut = false
    let cancelled = false
    let pending = ''
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: filteredEnv(),
      windowsHide: true,
      detached: process.platform !== 'win32',
      shell: opts.command === undefined && process.platform === 'win32', // npm.cmd, etc. (argumentos ya validados)
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const onData = (b: Buffer) => {
      const text = b.toString()
      if (output.length < MAX_OUTPUT) output += text
      else truncated = true
      pending += text
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() ?? ''
      lines.forEach((l) => opts.onOutput?.(l))
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, opts.timeoutMs)
    const onAbort = () => {
      cancelled = true
      killTree(child)
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    const done = (exitCode: number | null, extra = '') => {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      if (pending) opts.onOutput?.(pending)
      resolve({ exitCode, output: (output + extra).replace(/\u001b\[[0-9;]*m/g, ''), timedOut, cancelled, truncated, durationMs: Date.now() - started })
    }
    child.on('error', (e) => done(null, `\n${e.message}`))
    child.on('close', (code) => done(code))
  })
}

/** Recorta una salida larga conservando el principio y el final. */
export function clip(text: string, max = 12_000): string {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.4)
  return `${text.slice(0, head)}\n… [${text.length - max} caracteres omitidos] …\n${text.slice(text.length - (max - head))}`
}

export const defaultShell = (setting: 'powershell' | 'cmd' | 'gitbash'): RunOptions['shell'] => (process.platform === 'win32' ? setting : 'posix')
export const homedir = os.homedir
