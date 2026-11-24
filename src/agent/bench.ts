import { metricsOf, OllamaClient } from '@shared/ollama/client'
import type { BenchResult } from '@shared/agent/host'
import { OllamaProvider } from './providers/ollama'

/**
 * Banco de pruebas (ARCHITECTURE §6.3): mide en el equipo real lo que importa para un agente.
 * Los resultados se guardan y deciden el modelo y el protocolo por defecto con datos, no con suposiciones.
 */

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'Lista los archivos de una carpeta del proyecto.',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'Ruta relativa de la carpeta, "." para la raíz' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Lee el contenido de un archivo del proyecto.',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'Ruta relativa del archivo' } }, required: ['path'] },
    },
  },
]

const TOOL_NAMES = new Set(['list_files', 'read_file'])

const TOOL_PROMPTS: [string, 'list_files' | 'read_file'][] = [
  ['¿Qué archivos hay en la carpeta src?', 'list_files'],
  ['Lee el archivo package.json y dime su versión.', 'read_file'],
  ['Muéstrame el contenido de src/App.tsx', 'read_file'],
  ['Necesito ver qué hay en la raíz del proyecto.', 'list_files'],
  ['Abre README.md', 'read_file'],
]

const JSON_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['tool', 'final'] },
    tool: { type: 'string', enum: ['list_files', 'read_file'] },
    args: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    message: { type: 'string' },
  },
  required: ['action'],
}

const SYSTEM_TOOLS = 'Eres un agente de programación. Para responder necesitas usar herramientas sobre el proyecto del usuario. Usa siempre una herramienta cuando la petición lo requiera.'
const SYSTEM_JSON = `${SYSTEM_TOOLS} Responde SOLO con JSON: {"action":"tool","tool":"list_files"|"read_file","args":{"path":"..."}} para usar una herramienta, o {"action":"final","message":"..."} para terminar.`

const SNIPPET = `export function sumar(a: number, b: number): number {
  return a + b
}

export function formatear(precio: number): string {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(precio)
}
`

export async function runBench(
  host: string,
  model: string,
  numCtx: number,
  signal: AbortSignal,
  onStep: (step: string, index: number, total: number) => void,
): Promise<BenchResult> {
  const client = new OllamaClient(host)
  const provider = new OllamaProvider(client)
  const caps = await provider.capabilities(model)
  const total = caps.tools ? 6 : 5
  let i = 0
  const step = (s: string) => onStep(s, ++i, total)
  const options = { num_ctx: numCtx, temperature: 0, seed: 42 }

  step('Cargando el modelo en memoria')
  // Descargar primero para medir una carga en frío
  await client.keepAlive(model, 0).catch(() => {})
  const warm = await client.chatOnce({ model, messages: [{ role: 'user', content: 'Responde solo: OK' }], options: { ...options, num_predict: 4 }, think: caps.thinking ? false : undefined }, signal)
  const loadMs = metricsOf(warm).loadMs
  const ps = await client.ps().catch(() => ({ models: [] }))
  const loaded = ps.models.find((m) => m.name === model || m.model === model)
  const gpuPercent = loaded && loaded.size > 0 ? Math.round((loaded.size_vram / loaded.size) * 100) : null

  step('Velocidad de generación')
  const gen = await client.chatOnce(
    { model, messages: [{ role: 'user', content: 'Escribe en TypeScript una función que valide un NIF español, con comentarios breves.' }], options: { ...options, num_predict: 256 }, think: caps.thinking ? false : undefined },
    signal,
  )
  const genM = metricsOf(gen)

  step('Procesamiento de contexto (prefill)')
  const nonce = Math.random().toString(36).slice(2) // evita reutilizar la caché de un intento anterior
  const big = `// lote ${nonce}\n${SNIPPET.repeat(40)}`
  const pre = await client.chatOnce(
    { model, messages: [{ role: 'user', content: `${big}\n¿Cuántas funciones distintas se definen arriba? Responde solo con un número.` }], options: { ...options, num_predict: 8 }, think: caps.thinking ? false : undefined },
    signal,
  )
  const preM = metricsOf(pre)

  let toolsNative: BenchResult['toolsNative'] = null
  if (caps.tools) {
    step('Llamadas a herramientas (protocolo nativo)')
    let valid = 0
    for (const [prompt, expected] of TOOL_PROMPTS) {
      if (signal.aborted) break
      const r = await client.chatOnce(
        { model, messages: [{ role: 'system', content: SYSTEM_TOOLS }, { role: 'user', content: prompt }], tools: TOOLS, options, think: caps.thinking ? false : undefined },
        signal,
      )
      const call = r.message?.tool_calls?.[0]?.function
      const args = typeof call?.arguments === 'string' ? safeJson(call.arguments) : call?.arguments
      // Válida = herramienta existente + argumentos correctos. Elegir otra herramienta razonable (p. ej. listar antes de leer) no es un error de formato.
      if (call && TOOL_NAMES.has(call.name) && typeof (args as { path?: unknown } | undefined)?.path === 'string') valid++
      void expected
    }
    toolsNative = { valid, total: TOOL_PROMPTS.length }
  }

  step('Llamadas a herramientas (JSON estructurado)')
  let validJson = 0
  for (const [prompt, expected] of TOOL_PROMPTS) {
    if (signal.aborted) break
    const r = await client.chatOnce(
      { model, messages: [{ role: 'system', content: SYSTEM_JSON }, { role: 'user', content: prompt }], format: JSON_SCHEMA, options, think: caps.thinking ? false : undefined },
      signal,
    )
    const parsed = safeJson(r.message?.content ?? '') as { action?: string; tool?: string; args?: { path?: unknown } } | null
    if (parsed?.action === 'tool' && TOOL_NAMES.has(parsed.tool ?? '') && typeof parsed.args?.path === 'string') validJson++
    void expected
  }

  step('Resultados')
  return {
    model,
    numCtx,
    loadMs,
    genTokensPerSec: genM.tokensPerSec,
    prefillTokensPerSec: preM.prefillTokensPerSec,
    prefillTokens: preM.promptTokens,
    gpuPercent,
    toolsNative,
    toolsJson: { valid: validJson, total: TOOL_PROMPTS.length },
    capabilities: Object.entries(caps)
      .filter(([k, v]) => v === true && k !== 'completion')
      .map(([k]) => k),
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}
