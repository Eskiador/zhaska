import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as pty from 'node-pty'
import { AppError } from '@core/errors'

export interface TerminalInfo {
  id: string
  projectId: string
  title: string
  shell: string
  alive: boolean
}

interface Session extends TerminalInfo {
  proc: pty.IPty
  buffer: string
  timer: NodeJS.Timeout | null
}

/** Programa y argumentos de la shell elegida en Configuración → Editor → Terminal. */
export function resolveShell(setting: 'powershell' | 'cmd' | 'gitbash'): { file: string; args: string[]; label: string } {
  if (process.platform === 'win32') {
    if (setting === 'cmd') return { file: 'cmd.exe', args: [], label: 'Símbolo del sistema' }
    if (setting === 'gitbash') {
      const candidates = [path.join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'), path.join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'Git', 'bin', 'bash.exe')]
      const found = candidates.find((c) => existsSync(c))
      if (found) return { file: found, args: ['--login', '-i'], label: 'Git Bash' }
    }
    return { file: 'powershell.exe', args: ['-NoLogo'], label: 'PowerShell' }
  }
  const sh = process.env['SHELL'] || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
  return { file: sh, args: ['-l'], label: path.basename(sh) }
}

/**
 * Terminales reales (ConPTY en Windows, pty en macOS/Linux) con node-pty.
 * Siempre se abren en la raíz del proyecto. La salida se agrupa cada 16 ms para no saturar el IPC.
 */
export class TerminalService {
  private sessions = new Map<string, Session>()

  constructor(private readonly send: (channel: 'terminal.data' | 'terminal.exit', payload: unknown) => void) {}

  create(projectId: string, root: string, setting: 'powershell' | 'cmd' | 'gitbash', cols: number, rows: number): TerminalInfo {
    if (!existsSync(root)) throw new AppError('NOT_FOUND', 'La carpeta del proyecto no existe')
    const shell = resolveShell(setting)
    const id = randomUUID()
    let proc: pty.IPty
    try {
      proc = pty.spawn(shell.file, shell.args, {
        name: 'xterm-256color',
        cols: Math.max(20, cols),
        rows: Math.max(5, rows),
        cwd: root,
        env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'ZHASKA' } as Record<string, string>,
        useConpty: process.platform === 'win32' ? true : undefined,
      })
    } catch (e) {
      throw new AppError('IO', `No se pudo abrir la terminal (${shell.label}): ${(e as Error).message}`)
    }
    const count = [...this.sessions.values()].filter((s) => s.projectId === projectId).length
    const session: Session = { id, projectId, title: count ? `${shell.label} ${count + 1}` : shell.label, shell: shell.label, alive: true, proc, buffer: '', timer: null }
    this.sessions.set(id, session)
    proc.onData((data) => {
      session.buffer += data
      session.timer ??= setTimeout(() => {
        session.timer = null
        const chunk = session.buffer
        session.buffer = ''
        this.send('terminal.data', { id, data: chunk })
      }, 16)
    })
    proc.onExit(({ exitCode }) => {
      session.alive = false
      if (session.buffer) this.send('terminal.data', { id, data: session.buffer })
      session.buffer = ''
      this.send('terminal.exit', { id, exitCode })
    })
    return this.info(session)
  }

  private info(s: Session): TerminalInfo {
    return { id: s.id, projectId: s.projectId, title: s.title, shell: s.shell, alive: s.alive }
  }

  private get(id: string) {
    const s = this.sessions.get(id)
    if (!s) throw new AppError('NOT_FOUND', 'La terminal ya no existe')
    return s
  }

  write(id: string, data: string) {
    const s = this.get(id)
    if (s.alive) s.proc.write(data)
  }

  resize(id: string, cols: number, rows: number) {
    const s = this.get(id)
    if (s.alive) s.proc.resize(Math.max(20, cols), Math.max(5, rows))
  }

  kill(id: string) {
    const s = this.sessions.get(id)
    if (!s) return
    if (s.alive) s.proc.kill()
    this.sessions.delete(id)
  }

  list(projectId: string): TerminalInfo[] {
    return [...this.sessions.values()].filter((s) => s.projectId === projectId).map((s) => this.info(s))
  }

  killProject(projectId: string) {
    for (const s of [...this.sessions.values()]) if (s.projectId === projectId) this.kill(s.id)
  }

  dispose() {
    for (const s of [...this.sessions.values()]) this.kill(s.id)
  }
}

export const homedir = os.homedir
