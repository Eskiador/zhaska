import { app, shell } from 'electron'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { OllamaClient, type OllamaPsModel } from '@shared/ollama/client'
import type { OllamaStatus, LoadedModel } from '@shared/ipc/contract'
import { AppError } from '@core/errors'

const LOG_LINES = 300

/**
 * Supervisor de Ollama (ARCHITECTURE §7.1): detecta la instalación, comprueba la API cada 3 s,
 * lo inicia (como proceso hijo, con las variables de memoria optimizada) y, en Windows, lo instala.
 */
export class OllamaSupervisor {
  private child: ChildProcess | null = null
  private timer: NodeJS.Timeout | null = null
  private logs: string[] = []
  private client: OllamaClient
  status: OllamaStatus
  loaded: LoadedModel[] = []

  constructor(
    private host: string,
    private readonly onChange: (status: OllamaStatus, loaded: LoadedModel[]) => void,
    private readonly optimizeMemory: () => boolean,
  ) {
    this.client = new OllamaClient(host)
    this.status = { state: 'checking', host, version: null, binaryPath: null, managed: false, startedAt: null, error: null, installing: null }
  }

  get api() {
    return this.client
  }

  setHost(host: string) {
    if (host === this.host) return
    this.host = host
    this.client = new OllamaClient(host)
    this.patch({ host })
    void this.check()
  }

  startPolling() {
    void this.check()
    this.timer = setInterval(() => void this.check(), 3000)
  }

  dispose() {
    if (this.timer) clearInterval(this.timer)
    // Solo se detiene el servidor si lo arrancó ZHASKA
    this.child?.kill()
  }

  private patch(p: Partial<OllamaStatus>, loaded?: LoadedModel[]) {
    const next = { ...this.status, ...p }
    const changed = JSON.stringify(next) !== JSON.stringify(this.status) || (loaded && JSON.stringify(loaded) !== JSON.stringify(this.loaded))
    this.status = next
    if (loaded) this.loaded = loaded
    if (changed) this.onChange(this.status, this.loaded)
  }

  async check(): Promise<OllamaStatus> {
    try {
      const { version } = await this.client.version()
      const ps = await this.client.ps().catch(() => ({ models: [] as OllamaPsModel[] }))
      this.patch(
        { state: 'connected', version, error: null, startedAt: this.status.startedAt ?? Date.now() },
        ps.models.map((m) => ({ name: m.name, sizeBytes: m.size, vramBytes: m.size_vram, contextLength: m.context_length ?? null, expiresAt: Date.parse(m.expires_at) || null })),
      )
    } catch {
      if (this.status.state === 'starting') return this.status
      const binaryPath = await this.findBinary()
      this.patch({ state: binaryPath ? 'stopped' : 'not-installed', binaryPath, version: null, startedAt: null }, [])
    }
    return this.status
  }

  async findBinary(): Promise<string | null> {
    const candidates: string[] = []
    if (process.platform === 'win32') {
      const local = process.env['LOCALAPPDATA']
      if (local) candidates.push(path.join(local, 'Programs', 'Ollama', 'ollama.exe'))
      candidates.push('C:\\Program Files\\Ollama\\ollama.exe')
    } else if (process.platform === 'darwin') {
      candidates.push('/Applications/Ollama.app/Contents/Resources/ollama', '/opt/homebrew/bin/ollama', '/usr/local/bin/ollama')
    } else {
      candidates.push('/usr/local/bin/ollama', '/usr/bin/ollama')
    }
    const found = candidates.find((c) => existsSync(c))
    if (found) return found
    return new Promise((resolve) => {
      execFile(process.platform === 'win32' ? 'where' : 'which', ['ollama'], { timeout: 3000, windowsHide: true }, (err, out) => resolve(err ? null : out.split(/\r?\n/)[0]!.trim() || null))
    })
  }

  getLogs(): string[] {
    return [...this.logs]
  }

  private log(line: string) {
    this.logs.push(line)
    if (this.logs.length > LOG_LINES) this.logs.splice(0, this.logs.length - LOG_LINES)
  }

  /** Inicia `ollama serve` como proceso hijo y espera a que responda la API. */
  async start(): Promise<OllamaStatus> {
    if ((await this.check()).state === 'connected') return this.status
    const bin = await this.findBinary()
    if (!bin) throw new AppError('NOT_FOUND', 'Ollama no está instalado en este equipo')
    const url = new URL(this.host)
    const env: NodeJS.ProcessEnv = { ...process.env, OLLAMA_HOST: `${url.hostname}:${url.port || '11434'}` }
    if (this.optimizeMemory()) {
      env['OLLAMA_FLASH_ATTENTION'] = '1'
      env['OLLAMA_KV_CACHE_TYPE'] = 'q8_0'
    }
    this.patch({ state: 'starting', error: null })
    this.logs = []
    const child = spawn(bin, ['serve'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child
    const onData = (b: Buffer) => b.toString().split(/\r?\n/).filter(Boolean).forEach((l) => this.log(l))
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('exit', (code) => {
      this.log(`[ZHASKA] ollama serve terminó (código ${code})`)
      if (this.child === child) this.child = null
      this.patch({ managed: false })
      void this.check()
    })
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500))
      try {
        const { version } = await this.client.version(1000)
        this.patch({ state: 'connected', version, managed: true, startedAt: Date.now(), binaryPath: bin })
        return this.status
      } catch {
        if (!this.child) break
      }
    }
    this.patch({ state: 'error', error: 'Ollama no respondió tras iniciarlo. Revisa los registros.' })
    throw new AppError('IO', 'Ollama no respondió tras iniciarlo')
  }

  async stop(): Promise<void> {
    if (!this.child) throw new AppError('FORBIDDEN', 'ZHASKA no inició este servidor de Ollama. Ciérralo desde su icono en la bandeja del sistema.')
    this.child.kill()
    this.child = null
    this.patch({ managed: false })
    await new Promise((r) => setTimeout(r, 600))
    await this.check()
  }

  /**
   * Instalación (con consentimiento previo en la UI).
   * Windows: descarga el instalador oficial, verifica la firma Authenticode y lo ejecuta.
   * macOS/Linux: abre la página oficial de descarga.
   */
  async install(onProgress: (fraction: number) => void): Promise<'installed' | 'opened-download'> {
    if (process.platform !== 'win32') {
      await shell.openExternal('https://ollama.com/download')
      return 'opened-download'
    }
    const file = path.join(app.getPath('temp'), `OllamaSetup-${Date.now()}.exe`)
    this.patch({ installing: 'downloading' })
    try {
      const res = await fetch('https://ollama.com/download/OllamaSetup.exe')
      if (!res.ok || !res.body) throw new AppError('IO', `Descarga fallida (HTTP ${res.status})`)
      const total = Number(res.headers.get('content-length')) || 0
      let done = 0
      const body = Readable.fromWeb(res.body as never)
      body.on('data', (c: Buffer) => {
        done += c.length
        if (total) onProgress(done / total)
      })
      await pipeline(body, createWriteStream(file))
      this.patch({ installing: 'verifying' })
      const sig = await new Promise<string>((resolve) =>
        execFile(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', `$s = Get-AuthenticodeSignature -FilePath '${file.replace(/'/g, "''")}'; "$($s.Status)|$($s.SignerCertificate.Subject)"`],
          { timeout: 30_000, windowsHide: true },
          (_e, out) => resolve(out.trim()),
        ),
      )
      const [state, subject] = sig.split('|')
      if (state !== 'Valid' || !/ollama/i.test(subject ?? '')) throw new AppError('FORBIDDEN', `La firma del instalador no es válida (${sig || 'sin firma'}). Instalación cancelada.`)
      this.patch({ installing: 'installing' })
      await new Promise<void>((resolve, reject) => {
        const p = spawn(file, [], { windowsHide: false })
        p.on('exit', (code) => (code === 0 ? resolve() : reject(new AppError('IO', `El instalador terminó con código ${code}`))))
        p.on('error', reject)
      })
      for (let i = 0; i < 60 && (await this.check()).state !== 'connected'; i++) await new Promise((r) => setTimeout(r, 1000))
      return 'installed'
    } finally {
      this.patch({ installing: null })
      await rm(file, { force: true }).catch(() => {})
    }
  }
}

export const platformLabel = () => `${os.type()} ${os.release()}`
