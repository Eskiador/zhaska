import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PathGuard } from '@core/security/pathGuard'
import type { InstalledModel, PullProgress } from '@shared/ipc/contract'
import { contextLengthOf, metricsOf, OllamaError, type OllamaClient } from '@shared/ollama/client'
import { GEMMA4_VARIANTS } from '@shared/models/catalog'
import { AppError } from '@core/errors'

/** Traduce los estados de `/api/pull` a las fases de la UI (diseño: Manifiesto · Capas · Verificar sha256 · Registrar). */
export function pullPhase(status: string): PullProgress['phase'] {
  if (status === 'success') return 'done'
  if (/manifest/.test(status) && status.startsWith('pulling')) return 'manifest'
  if (status.startsWith('pulling')) return 'layers'
  if (/verifying/.test(status)) return 'verify'
  return 'register'
}

/** Acumula el progreso por capa (digest) y calcula la velocidad con una ventana deslizante. */
export class PullTracker {
  private layers = new Map<string, { total: number; completed: number }>()
  private samples: { t: number; bytes: number }[] = []
  progress: PullProgress

  constructor(jobId: string, name: string, source: PullProgress['source'] = 'ollama', note: string | null = null) {
    this.progress = { jobId, name, phase: 'manifest', completed: 0, total: 0, bytesPerSec: 0, error: null, source, note }
  }

  update(chunk: { status: string; digest?: string; total?: number; completed?: number }, now = Date.now()): PullProgress {
    const phase = pullPhase(chunk.status)
    if (chunk.digest && chunk.total) this.layers.set(chunk.digest, { total: chunk.total, completed: chunk.completed ?? 0 })
    let total = 0
    let completed = 0
    for (const l of this.layers.values()) {
      total += l.total
      completed += l.completed
    }
    this.samples.push({ t: now, bytes: completed })
    while (this.samples.length > 2 && now - this.samples[0]!.t > 5000) this.samples.shift()
    const first = this.samples[0]!
    const dt = (now - first.t) / 1000
    const bytesPerSec = dt > 0.5 ? Math.max(0, (completed - first.bytes) / dt) : this.progress.bytesPerSec
    this.progress = { ...this.progress, phase, total, completed, bytesPerSec }
    return this.progress
  }
}

export class ModelService {
  private pulls = new Map<string, { ctrl: AbortController; tracker: PullTracker }>()

  constructor(
    private readonly client: () => OllamaClient,
    private readonly emit: (p: PullProgress) => void,
  ) {}

  async list(): Promise<InstalledModel[]> {
    try {
      const { models } = await this.client().tags()
      return Promise.all(
        models.map(async (m) => {
          // Versiones recientes de Ollama ya incluyen capacidades y contexto en /api/tags; si no, /api/show.
          let caps = m.capabilities
          let ctx = m.details?.context_length ?? null
          if (!caps || ctx === null) {
            const show = await this.client().show(m.name).catch(() => null)
            caps ??= show?.capabilities ?? ['completion']
            ctx ??= show ? contextLengthOf(show) : null
          }
          return {
            name: m.name,
            sizeBytes: m.size,
            family: m.details?.family ?? null,
            parameterSize: m.details?.parameter_size ?? null,
            quantization: m.details?.quantization_level ?? null,
            contextLength: ctx,
            capabilities: caps,
            modifiedAt: Date.parse(m.modified_at) || 0,
          }
        }),
      )
    } catch (e) {
      throw toAppError(e)
    }
  }

  activePulls(): PullProgress[] {
    return [...this.pulls.values()].map((p) => p.tracker.progress)
  }

  /**
   * Descarga un modelo. Origen:
   * - 'ollama': servidor de Ollama.
   * - 'huggingface': repositorio oficial de Google en Hugging Face + modelo derivado con el renderer/parser
   *   de Ollama para Gemma 4 (sin eso se perderían las herramientas y el razonamiento).
   * - 'auto': Ollama y, si falla por la red, Hugging Face automáticamente.
   */
  pull(name: string, source: 'auto' | 'ollama' | 'huggingface' = 'auto'): { jobId: string } {
    const existing = [...this.pulls.values()].find((p) => p.tracker.progress.name === name)
    if (existing) return { jobId: existing.tracker.progress.jobId }
    const jobId = randomUUID()
    const ctrl = new AbortController()
    const hfRepo = GEMMA4_VARIANTS.find((v) => v.tag === name)?.hfRepo
    const useHf = source === 'huggingface' && !!hfRepo
    const entry = { ctrl, tracker: new PullTracker(jobId, name, useHf ? 'huggingface' : 'ollama', useHf ? 'Descargando la versión oficial de Google desde Hugging Face.' : null) }
    this.pulls.set(jobId, entry)
    void (async () => {
      try {
        if (!useHf) {
          try {
            await this.stream(name, entry, ctrl.signal)
            this.emit({ ...entry.tracker.progress, phase: 'done' })
            return
          } catch (e) {
            const msg = toAppError(e).message
            if (ctrl.signal.aborted || source !== 'auto' || !hfRepo || !isNetworkError(msg)) throw e
            // El servidor de descargas de Ollama no responde: misma versión oficial desde Hugging Face
            entry.tracker = new PullTracker(jobId, name, 'huggingface', 'El servidor de descargas de Ollama no responde; descargando la misma versión oficial de Google desde Hugging Face.')
            this.emit(entry.tracker.progress)
          }
        }
        await this.fromHuggingFace(name, hfRepo!, entry, ctrl.signal)
        this.emit({ ...entry.tracker.progress, phase: 'done' })
      } catch (e) {
        const cancelled = ctrl.signal.aborted
        this.emit({ ...entry.tracker.progress, phase: cancelled ? 'cancelled' : 'error', error: cancelled ? null : friendlyPullError(toAppError(e).message) })
      } finally {
        this.pulls.delete(jobId)
      }
    })()
    return { jobId }
  }

  private async stream(model: string, entry: { tracker: PullTracker }, signal: AbortSignal) {
    let last = 0
    for await (const chunk of this.client().pull(model, signal)) {
      const p = entry.tracker.update(chunk)
      // "success" de Ollama no es el final: el "terminado" lo anuncia pull() cuando todo ha acabado
      if (p.phase === 'done') continue
      const now = Date.now()
      if (now - last > 200 || p.phase !== 'layers') {
        last = now
        this.emit(p)
      }
    }
  }

  private async fromHuggingFace(name: string, repo: string, entry: { tracker: PullTracker }, signal: AbortSignal) {
    const hfName = `hf.co/${repo}:latest`
    await this.stream(hfName, entry, signal)
    // Fase "Registrar": modelo con el nombre del catálogo y el renderer/parser de Gemma 4
    this.emit({ ...entry.tracker.progress, phase: 'register' })
    await this.client().create({ model: name, from: hfName, renderer: 'gemma4', parser: 'gemma4' })
    // La copia de Hugging Face comparte archivos con el modelo creado: quitarla solo limpia la lista
    await this.client().delete(hfName).catch(() => {})
  }

  cancelPull(jobId: string) {
    this.pulls.get(jobId)?.ctrl.abort()
  }

  async delete(name: string) {
    await this.client().delete(name).catch((e) => {
      throw toAppError(e)
    })
  }

  async load(name: string) {
    await this.client().keepAlive(name, '10m').catch((e) => {
      throw toAppError(e)
    })
  }

  /** Prueba de funcionamiento: una respuesta corta real del modelo. */
  async test(name: string) {
    try {
      const r = await this.client().chatOnce({ model: name, messages: [{ role: 'user', content: 'Responde solo con la palabra: listo' }], options: { num_predict: 16, temperature: 0 }, think: false })
      const m = metricsOf(r)
      return { reply: (r.message?.content ?? '').trim(), totalMs: m.totalMs, tokensPerSec: m.tokensPerSec, loadMs: m.loadMs }
    } catch (e) {
      throw toAppError(e)
    }
  }

  /**
   * Prueba del asistente inicial (ARCHITECTURE §11.1, paso 6): proyecto de ejemplo en una carpeta temporal,
   * el modelo debe pedir `list_files`, la herramienta se ejecuta de verdad (con PathGuard) y el modelo debe
   * responder con lo que encontró. Mide la velocidad. La carpeta temporal se borra al terminar.
   */
  async toolTest(name: string): Promise<{ ok: boolean; called: string | null; reply: string; totalMs: number; tokensPerSec: number; note: string }> {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'zhaska-prueba-')))
    try {
      mkdirSync(join(dir, 'src'))
      writeFileSync(join(dir, 'src', 'calculadora.ts'), 'export const sumar = (a: number, b: number) => a + b\n')
      writeFileSync(join(dir, 'README.md'), '# Proyecto de prueba\n')
      const guard = new PathGuard(dir)
      const tools = [
        {
          type: 'function',
          function: { name: 'list_files', description: 'Lista el contenido de una carpeta del proyecto.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Ruta relativa, p. ej. "src"' } }, required: ['path'] } },
        },
      ]
      const messages: { role: string; content: string; tool_calls?: unknown[]; tool_name?: string }[] = [
        { role: 'system', content: 'Eres un agente de programación. Usa las herramientas para responder; no inventes nombres de archivo.' },
        { role: 'user', content: '¿Qué archivo hay dentro de la carpeta src? Responde con su nombre.' },
      ]
      const t0 = Date.now()
      const first = await this.client().chatOnce({ model: name, messages: messages as never, tools, options: { temperature: 0, num_predict: 200 }, think: false })
      const call = first.message?.tool_calls?.[0]?.function
      if (!call) return { ok: false, called: null, reply: (first.message?.content ?? '').trim().slice(0, 200), totalMs: Date.now() - t0, tokensPerSec: metricsOf(first).tokensPerSec, note: 'El modelo respondió sin usar herramientas: el agente usará el protocolo JSON estructurado, más lento.' }
      const args = (typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments) as { path?: string }
      let listing: string
      try {
        const abs = guard.resolve(String(args.path ?? '.').replace(/^\.?\/?/, ''))
        listing = readdirSync(abs)
          .map((n) => `${n}${statSync(join(abs, n)).isDirectory() ? '/' : ''}`)
          .join('\n')
      } catch (e) {
        listing = `Error: ${(e as Error).message}`
      }
      messages.push({ role: 'assistant', content: first.message?.content ?? '', tool_calls: first.message?.tool_calls }, { role: 'tool', content: listing, tool_name: call.name })
      const second = await this.client().chatOnce({ model: name, messages: messages as never, tools, options: { temperature: 0, num_predict: 120 }, think: false })
      const reply = (second.message?.content ?? '').trim()
      const ok = call.name === 'list_files' && /calculadora/i.test(reply)
      return {
        ok,
        called: `${call.name}(${JSON.stringify(args)})`,
        reply: reply.slice(0, 200),
        totalMs: Date.now() - t0,
        tokensPerSec: metricsOf(second).tokensPerSec || metricsOf(first).tokensPerSec,
        note: ok ? 'El modelo usó la herramienta y respondió con el resultado real.' : 'El modelo llamó a la herramienta pero no usó bien el resultado.',
      }
    } catch (e) {
      throw toAppError(e)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  async unload(name: string) {
    await this.client().keepAlive(name, 0).catch((e) => {
      throw toAppError(e)
    })
  }
}

/** Errores de red típicos de Ollama al descargar (servidor de descargas inalcanzable). */
export const isNetworkError = (message: string) => /i\/o timeout|max retries exceeded|connection refused|no such host|TLS handshake|connection reset|network is unreachable/i.test(message)

export function friendlyPullError(message: string): string {
  if (isNetworkError(message)) {
    return 'No se pudo conectar con el servidor de descargas de Ollama (almacenamiento de Cloudflare). Comprueba tu conexión. Algunos proveedores bloquean temporalmente direcciones de Cloudflare (en España, por ejemplo, durante partidos de fútbol): vuelve a intentarlo más tarde o desde otra red. La descarga continúa donde se quedó.'
  }
  if (/no space left/i.test(message)) return 'No queda espacio en el disco para descargar el modelo.'
  return message
}

export function toAppError(e: unknown): AppError {
  if (e instanceof AppError) return e
  if (e instanceof OllamaError) {
    if (e.kind === 'unavailable') return new AppError('IO', 'Ollama no está en ejecución')
    if (e.kind === 'not-found') return new AppError('NOT_FOUND', /model/i.test(e.message) ? `Modelo no encontrado: ${e.message}` : e.message)
    return new AppError('IO', e.message)
  }
  return new AppError('INTERNAL', (e as Error)?.message ?? String(e))
}
