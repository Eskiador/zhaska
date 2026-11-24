import { contextLengthOf, metricsOf, OllamaClient, type ChatMetrics, type OllamaChatMessage } from '@shared/ollama/client'
import type { ModelPhase } from '@shared/agent/host'
import type { ModelCapabilities, ModelProvider, ProviderChatRequest, ProviderChunk } from './provider'

/** Proveedor Ollama: normaliza el streaming NDJSON a `ProviderChunk`. El texto de razonamiento no sale de aquí. */
export class OllamaProvider implements ModelProvider {
  readonly id = 'ollama'
  private readonly caps = new Map<string, ModelCapabilities>()

  constructor(readonly client: OllamaClient) {}

  async capabilities(model: string): Promise<ModelCapabilities> {
    const cached = this.caps.get(model)
    if (cached) return cached
    const show = await this.client.show(model)
    const list = show.capabilities ?? ['completion']
    const caps: ModelCapabilities = {
      completion: list.includes('completion'),
      tools: list.includes('tools'),
      vision: list.includes('vision'),
      thinking: list.includes('thinking'),
      contextLength: contextLengthOf(show),
    }
    this.caps.set(model, caps)
    return caps
  }

  async *chat(req: ProviderChatRequest, signal: AbortSignal): AsyncGenerator<ProviderChunk> {
    const caps = await this.capabilities(req.model)
    // ¿Hay que cargar el modelo en memoria antes de empezar? (primer uso o tras liberarse)
    const loaded = await this.client.ps().then(
      (r) => r.models.some((m) => m.name === req.model || m.model === req.model),
      () => true,
    )
    yield { type: 'state', state: loaded ? 'prompt' : 'loading' }

    let phase: 'prompt' | 'thinking' | 'generating' | 'loading' = loaded ? 'prompt' : 'loading'
    for await (const chunk of this.client.chat(
      {
        model: req.model,
        messages: req.messages,
        think: caps.thinking ? req.think : undefined,
        options: { num_ctx: req.numCtx, temperature: req.temperature },
      },
      signal,
    )) {
      if (chunk.message?.thinking && phase !== 'thinking') {
        phase = 'thinking'
        yield { type: 'state', state: 'thinking' }
      }
      const text = chunk.message?.content
      if (text) {
        if (phase !== 'generating') {
          phase = 'generating'
          yield { type: 'state', state: 'generating' }
        }
        yield { type: 'text', text }
      }
      if (chunk.done) yield { type: 'done', metrics: metricsOf(chunk), doneReason: chunk.done_reason ?? 'stop' }
    }
  }
}

export interface StepRequest {
  model: string
  messages: OllamaChatMessage[]
  tools?: unknown[]
  format?: unknown
  numCtx: number
  temperature: number
  think: boolean
}

export interface StepResult {
  content: string
  toolCalls: { name: string; args: unknown }[]
  metrics: ChatMetrics
}

/** Un paso del agente: una llamada al modelo con herramientas o formato JSON, en streaming. */
export async function runStep(provider: OllamaProvider, req: StepRequest, signal: AbortSignal, on: { phase: (p: ModelPhase) => void; delta?: (t: string) => void }): Promise<StepResult> {
  const caps = await provider.capabilities(req.model)
  let content = ''
  const toolCalls: StepResult['toolCalls'] = []
  let metrics: ChatMetrics | null = null
  let phase: ModelPhase | null = null
  const setPhase = (p: ModelPhase) => {
    if (phase !== p) on.phase((phase = p))
  }
  setPhase('prompt')
  for await (const chunk of provider.client.chat(
    { model: req.model, messages: req.messages, tools: req.tools, format: req.format, think: caps.thinking ? req.think : undefined, options: { num_ctx: req.numCtx, temperature: req.temperature } },
    signal,
  )) {
    if (chunk.message?.thinking) setPhase('thinking')
    if (chunk.message?.content) {
      setPhase('generating')
      content += chunk.message.content
      on.delta?.(chunk.message.content)
    }
    for (const tc of chunk.message?.tool_calls ?? []) toolCalls.push({ name: tc.function.name, args: tc.function.arguments })
    if (chunk.done) metrics = metricsOf(chunk)
  }
  return { content, toolCalls, metrics: metrics ?? metricsOf({ model: req.model, done: true }) }
}
