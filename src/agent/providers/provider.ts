import type { ChatMetrics } from '@shared/ollama/client'
import type { ChatTurn, ModelPhase } from '@shared/agent/host'

/**
 * Capa de proveedores (ARCHITECTURE §6.2): el motor del agente solo conoce esta interfaz.
 * Añadir otro proveedor (otro servidor local, una API compatible con OpenAI…) no cambia el resto.
 */
export interface ModelCapabilities {
  completion: boolean
  tools: boolean
  vision: boolean
  thinking: boolean
  contextLength: number | null
}

export interface ProviderChatRequest {
  model: string
  messages: ChatTurn[]
  numCtx: number
  temperature: number
  think: boolean
}

export type ProviderChunk =
  | { type: 'state'; state: ModelPhase }
  | { type: 'text'; text: string }
  | { type: 'done'; metrics: ChatMetrics; doneReason: string }

export interface ModelProvider {
  readonly id: string
  capabilities(model: string): Promise<ModelCapabilities>
  chat(req: ProviderChatRequest, signal: AbortSignal): AsyncIterable<ProviderChunk>
}
