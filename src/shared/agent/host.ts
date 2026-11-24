/**
 * Protocolo entre el proceso principal y el Agent Host (utilityProcess).
 * Solo datos serializables. El renderer nunca habla con el Agent Host directamente.
 */
import type { ChatMetrics } from '../ollama/client'
import type { AgentEvent } from './events'

export type ModelPhase = 'loading' | 'prompt' | 'thinking' | 'generating'

export interface ChatTurn {
  role: 'system' | 'user' | 'assistant'
  content: string
  /** Imágenes en base64 (solo modelos con visión) */
  images?: string[]
}

/** Adjunto legible por el agente con read_attachment (solo lectura, fuera del proyecto). */
export interface AttachmentRef {
  id: string
  name: string
  kind: string
  /** Texto extraído (userData/attachments/…/extracted.txt) */
  textFile: string
  /** Solo ZIP: carpeta con el contenido extraído de forma segura */
  unzipDir: string | null
  chars: number
}

export interface ChatStartRequest {
  type: 'chat.start'
  taskId: string
  host: string
  model: string
  messages: ChatTurn[]
  numCtx: number
  temperature: number
  think: boolean
}

export interface BenchRequest {
  type: 'bench.start'
  jobId: string
  host: string
  model: string
  numCtx: number
}

export interface AgentStartRequest {
  type: 'agent.start'
  host: string
  spec: {
    taskId: string
    model: string
    root: string
    projectName: string
    userMessage: string
    history: ChatTurn[]
    numCtx: number
    temperature: number
    think: boolean
    maxSteps: number
    protocol: 'auto' | 'native' | 'json'
    autonomy: 'ask' | 'balanced' | 'autonomous'
    permissions: Record<'read' | 'write' | 'execute' | 'install' | 'internet', 'allow' | 'ask' | 'block'>
    rules: { action: 'read' | 'write' | 'execute' | 'install' | 'internet'; pattern: string }[]
    protectedPatterns: string[]
    autoVerify: boolean
    shell: 'powershell' | 'cmd' | 'gitbash' | 'posix'
    blobDir: string
    /** Adjuntos de la conversación (Fase 8) */
    attachments?: AttachmentRef[]
    /** Texto de los adjuntos de este mensaje, ya preparado por main */
    attachmentContext?: string
    /** Imágenes de este mensaje para modelos con visión */
    images?: string[]
    attachmentNames?: string[]
    /** Carpetas autorizadas fuera del proyecto (solo lectura) y carpetas que nunca se leen (Fase 9) */
    externalDirs?: string[]
    blockedDirs?: string[]
  }
}

export type HostRequest =
  | ChatStartRequest
  | { type: 'chat.cancel'; taskId: string }
  | BenchRequest
  | { type: 'bench.cancel'; jobId: string }
  | AgentStartRequest
  | { type: 'agent.cancel'; taskId: string }
  | { type: 'agent.approval'; taskId: string; requestId: string; decision: 'allow_once' | 'allow_always' | 'deny' }
  | { type: 'agent.pause'; taskId: string }
  | { type: 'agent.resume'; taskId: string }

export type HostEvent =
  | { type: 'ready' }
  | { type: 'chat.state'; taskId: string; state: ModelPhase }
  | { type: 'chat.delta'; taskId: string; text: string }
  | { type: 'chat.done'; taskId: string; text: string; metrics: ChatMetrics; doneReason: string }
  | { type: 'chat.cancelled'; taskId: string; text: string }
  | { type: 'chat.error'; taskId: string; code: 'OLLAMA_UNAVAILABLE' | 'MODEL_NOT_FOUND' | 'MODEL_ERROR'; message: string; text: string }
  | { type: 'bench.progress'; jobId: string; step: string; index: number; total: number }
  | { type: 'bench.done'; jobId: string; result: BenchResult }
  | { type: 'bench.error'; jobId: string; message: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'agent.event'; taskId: string; event: AgentEvent }
  | { type: 'agent.text'; taskId: string; text: string }
  | { type: 'agent.change'; taskId: string; change: { rel: string; kind: 'create' | 'modify' | 'delete'; beforeHash: string | null; afterHash: string | null; additions: number; deletions: number } }
  | { type: 'agent.rule'; taskId: string; rule: { action: 'read' | 'write' | 'execute' | 'install' | 'internet'; pattern: string } }
  | { type: 'agent.done'; taskId: string; result: { status: 'completed' | 'failed' | 'cancelled'; text: string; error?: string; steps: { stepId: string; tool: string; title: string; target?: string; ok: boolean; diff?: { additions: number; deletions: number } }[]; metrics: { promptTokens: number; evalTokens: number; steps: number; lastTokensPerSec: number } } }

export interface BenchResult {
  model: string
  numCtx: number
  loadMs: number
  genTokensPerSec: number
  prefillTokensPerSec: number
  prefillTokens: number
  gpuPercent: number | null
  /** Llamadas a herramientas válidas con el protocolo nativo (null si el modelo no declara `tools`). */
  toolsNative: { valid: number; total: number } | null
  /** Llamadas válidas con salida JSON estructurada (`format`). */
  toolsJson: { valid: number; total: number }
  capabilities: string[]
}
