/**
 * Cliente mínimo de la API REST de Ollama (sin dependencias): fetch + NDJSON en streaming.
 * Lo usan el proceso principal (supervisor y modelos) y el Agent Host (chat). Nunca el renderer.
 */

export interface OllamaTagModel {
  name: string
  model: string
  modified_at: string
  size: number
  digest: string
  details?: { family?: string; parameter_size?: string; quantization_level?: string; format?: string; context_length?: number }
  capabilities?: string[]
}

export interface OllamaPsModel {
  name: string
  model: string
  size: number
  size_vram: number
  expires_at: string
  context_length?: number
  details?: { parameter_size?: string; quantization_level?: string }
}

export interface OllamaShow {
  capabilities?: string[]
  details?: { family?: string; parameter_size?: string; quantization_level?: string }
  model_info?: Record<string, unknown>
  modified_at?: string
}

export interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  images?: string[]
  thinking?: string
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> | string } }[]
  tool_name?: string
}

export interface OllamaChatChunk {
  model: string
  message?: OllamaChatMessage
  done: boolean
  done_reason?: string
  total_duration?: number
  load_duration?: number
  prompt_eval_count?: number
  prompt_eval_duration?: number
  eval_count?: number
  eval_duration?: number
  error?: string
}

export interface OllamaPullChunk {
  status: string
  digest?: string
  total?: number
  completed?: number
  error?: string
}

export interface ChatOptions {
  num_ctx?: number
  temperature?: number
  top_p?: number
  top_k?: number
  num_predict?: number
  seed?: number
}

export interface ChatBody {
  model: string
  messages: OllamaChatMessage[]
  stream?: boolean
  think?: boolean
  tools?: unknown[]
  format?: unknown
  options?: ChatOptions
  keep_alive?: string | number
}

export class OllamaError extends Error {
  constructor(
    readonly kind: 'unavailable' | 'not-found' | 'http' | 'aborted' | 'protocol',
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'OllamaError'
  }
}

/** Divide un flujo de bytes en objetos JSON por línea (NDJSON), tolerando trozos partidos. */
export async function* readNdjson<T>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (line) yield parseLine<T>(line)
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) yield parseLine<T>(buffer.trim())
  } finally {
    reader.releaseLock()
  }
}

function parseLine<T>(line: string): T {
  try {
    return JSON.parse(line) as T
  } catch {
    throw new OllamaError('protocol', `Respuesta no válida de Ollama: ${line.slice(0, 120)}`)
  }
}

export class OllamaClient {
  constructor(
    readonly host = 'http://127.0.0.1:11434',
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {}

  private async request(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
    const { timeoutMs, signal, ...rest } = init
    const timeout = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined
    const combined = signal && timeout ? AbortSignal.any([signal, timeout]) : (signal ?? timeout)
    let res: Response
    try {
      res = await this.fetchImpl(`${this.host}${path}`, { ...rest, signal: combined, headers: { 'content-type': 'application/json', ...(rest.headers ?? {}) } })
    } catch (e) {
      if (signal?.aborted) throw new OllamaError('aborted', 'Cancelado')
      if (timeout?.aborted) throw new OllamaError('unavailable', 'Ollama no respondió a tiempo')
      throw new OllamaError('unavailable', `No se pudo conectar con Ollama en ${this.host}`)
    }
    if (!res.ok) {
      let msg = `HTTP ${res.status}`
      try {
        const body = (await res.json()) as { error?: string }
        if (body?.error) msg = body.error
      } catch {
        /* sin cuerpo JSON */
      }
      throw new OllamaError(res.status === 404 ? 'not-found' : 'http', msg, res.status)
    }
    return res
  }

  private async json<T>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
    return (await (await this.request(path, init)).json()) as T
  }

  version(timeoutMs = 1500) {
    return this.json<{ version: string }>('/api/version', { timeoutMs })
  }
  tags() {
    return this.json<{ models: OllamaTagModel[] }>('/api/tags', { timeoutMs: 5000 })
  }
  ps() {
    return this.json<{ models: OllamaPsModel[] }>('/api/ps', { timeoutMs: 3000 })
  }
  show(model: string) {
    return this.json<OllamaShow>('/api/show', { method: 'POST', body: JSON.stringify({ model }), timeoutMs: 10_000 })
  }
  async delete(model: string) {
    await this.request('/api/delete', { method: 'DELETE', body: JSON.stringify({ model }), timeoutMs: 30_000 })
  }
  /** Carga el modelo en memoria sin generar (keep_alive) o lo descarga (keep_alive 0). */
  async keepAlive(model: string, keepAlive: string | number) {
    await this.request('/api/generate', { method: 'POST', body: JSON.stringify({ model, keep_alive: keepAlive, stream: false }), timeoutMs: 300_000 })
  }

  /** Crea un modelo derivado (p. ej. con el renderer/parser propios de Ollama para Gemma 4). */
  async create(body: { model: string; from: string; renderer?: string; parser?: string }) {
    const r = await this.json<{ status?: string; error?: string }>('/api/create', { method: 'POST', body: JSON.stringify({ ...body, stream: false }), timeoutMs: 300_000 })
    if (r.error) throw new OllamaError('http', r.error)
  }

  async *pull(model: string, signal?: AbortSignal): AsyncGenerator<OllamaPullChunk> {
    const res = await this.request('/api/pull', { method: 'POST', body: JSON.stringify({ model, stream: true }), signal })
    for await (const chunk of readNdjson<OllamaPullChunk>(res.body!)) {
      if (chunk.error) throw new OllamaError(/not found|does not exist/i.test(chunk.error) ? 'not-found' : 'http', chunk.error)
      yield chunk
    }
  }

  async *chat(body: ChatBody, signal?: AbortSignal): AsyncGenerator<OllamaChatChunk> {
    const res = await this.request('/api/chat', { method: 'POST', body: JSON.stringify({ ...body, stream: true }), signal })
    try {
      for await (const chunk of readNdjson<OllamaChatChunk>(res.body!)) {
        if (chunk.error) throw new OllamaError('http', chunk.error)
        yield chunk
      }
    } catch (e) {
      if (signal?.aborted) throw new OllamaError('aborted', 'Cancelado')
      throw e
    }
  }

  /** Vectores de significado (embeddings) de varios textos, en el mismo orden (Fase 12: bases de conocimiento). */
  async embed(model: string, input: string[], signal?: AbortSignal): Promise<number[][]> {
    const r = await this.json<{ embeddings?: number[][]; error?: string }>('/api/embed', { method: 'POST', body: JSON.stringify({ model, input, truncate: true }), signal, timeoutMs: 300_000 })
    if (!r.embeddings || r.embeddings.length !== input.length) throw new OllamaError('protocol', r.error ?? 'Ollama no devolvió los vectores esperados')
    return r.embeddings
  }

  /** Petición de chat sin streaming (banco de pruebas, utilidades). */
  async chatOnce(body: ChatBody, signal?: AbortSignal): Promise<OllamaChatChunk> {
    return this.json<OllamaChatChunk>('/api/chat', { method: 'POST', body: JSON.stringify({ ...body, stream: false }), signal })
  }
}

/** Longitud de contexto declarada en model_info (`<arquitectura>.context_length`). */
export function contextLengthOf(show: OllamaShow): number | null {
  const info = show.model_info ?? {}
  const arch = info['general.architecture']
  const v = typeof arch === 'string' ? info[`${arch}.context_length`] : undefined
  if (typeof v === 'number') return v
  const any = Object.entries(info).find(([k, val]) => k.endsWith('.context_length') && typeof val === 'number')
  return any ? (any[1] as number) : null
}

/** Métricas normalizadas a partir del último fragmento (`done: true`). Las duraciones de Ollama van en ns. */
export function metricsOf(c: OllamaChatChunk) {
  const ms = (ns?: number) => (ns ? ns / 1e6 : 0)
  const evalMs = ms(c.eval_duration)
  const promptMs = ms(c.prompt_eval_duration)
  return {
    promptTokens: c.prompt_eval_count ?? 0,
    evalTokens: c.eval_count ?? 0,
    loadMs: ms(c.load_duration),
    promptMs,
    evalMs,
    totalMs: ms(c.total_duration),
    tokensPerSec: evalMs > 0 ? ((c.eval_count ?? 0) / evalMs) * 1000 : 0,
    prefillTokensPerSec: promptMs > 0 ? ((c.prompt_eval_count ?? 0) / promptMs) * 1000 : 0,
  }
}
export type ChatMetrics = ReturnType<typeof metricsOf>
