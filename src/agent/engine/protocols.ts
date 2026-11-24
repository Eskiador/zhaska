import { existsSync } from 'node:fs'
import type { OllamaChatMessage } from '@shared/ollama/client'
import { toolSpecs, type ToolDef } from '../tools/registry'

export interface ParsedCall {
  name: string
  args: unknown
}

export interface ParsedStep {
  /** Texto para el usuario (respuesta final o explicación del paso) */
  text: string
  calls: ParsedCall[]
  /** El modelo respondió algo que no se pudo interpretar */
  parseError?: string
}

/**
 * Protocolo de llamadas a herramientas (ARCHITECTURE §6.3).
 * - native: `tools` de Ollama (modelos con la capacidad `tools`, como Gemma 4).
 * - json: salida estructurada con `format` (cualquier modelo). Una llamada por paso.
 */
export interface ToolProtocol {
  id: 'native' | 'json'
  /** El texto se puede mostrar en streaming (en JSON sería el objeto crudo) */
  streamsText: boolean
  /** Instrucciones del protocolo para las herramientas ofrecidas en esta tarea */
  instructions: (tools: ToolDef[]) => string
  request: (tools: ToolDef[]) => { tools?: unknown[]; format?: unknown }
  parse: (content: string, toolCalls: ParsedCall[]) => ParsedStep
  assistantTurn: (content: string, calls: ParsedCall[]) => OllamaChatMessage
  resultTurn: (call: ParsedCall, output: string) => OllamaChatMessage
}

/** Corrige formas habituales de equivocarse: camelCase, prefijos, argumentos como texto JSON. */
export function normalizeCall(call: ParsedCall): ParsedCall {
  let name = String(call.name ?? '').trim().replace(/^functions?\./, '')
  name = name.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()
  let args = call.args
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args)
    } catch {
      /* se valida después y se informa al modelo */
    }
  }
  if (args && typeof args === 'object') {
    const a = { ...(args as Record<string, unknown>) }
    // Los modelos suelen escribir "/archivo" queriendo decir la raíz del proyecto. Si esa ruta absoluta no existe
    // en el disco, se interpreta como relativa; si existe (p. ej. una carpeta autorizada), se respeta y las
    // reglas de lectura fuera del proyecto deciden (Fase 9). PathGuard sigue impidiendo salir del proyecto.
    if (typeof a['path'] === 'string') {
      const p = (a['path'] as string).replace(/\\/g, '/').replace(/^\.\//, '')
      // «/src/App.tsx»: /src no existe en la raíz del disco → es del proyecto. «/Users/ana/x»: /Users existe → absoluta.
      a['path'] = p.startsWith('/') && !p.startsWith('//') && !existsSync(`/${p.slice(1).split('/')[0]}`) ? p.slice(1) : p
    }
    args = a
  }
  return { name, args: args ?? {} }
}

export const nativeProtocol: ToolProtocol = {
  id: 'native',
  streamsText: true,
  instructions: () => 'Usa las herramientas disponibles mediante llamadas a funciones. Cuando hayas terminado, responde con texto normal sin llamar a ninguna herramienta.',
  request: (tools) => ({ tools: toolSpecs(tools) }),
  parse: (content, calls) => ({ text: content.trim(), calls: calls.map(normalizeCall) }),
  assistantTurn: (content, calls) => ({ role: 'assistant', content, tool_calls: calls.map((c) => ({ function: { name: c.name, arguments: (c.args ?? {}) as Record<string, unknown> } })) }),
  resultTurn: (call, output) => ({ role: 'tool', content: output, tool_name: call.name }),
}

const jsonFormat = (tools: ToolDef[]) => ({
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['tool', 'final'] },
    tool: { type: 'string', enum: tools.map((t) => t.name) },
    args: { type: 'object' },
    message: { type: 'string' },
  },
  required: ['action'],
})

function describeTools(tools: ToolDef[]): string {
  const specs = toolSpecs(tools)
  return tools.map((t) => {
    const spec = specs.find((s) => s.function.name === t.name)!.function.parameters as { properties?: Record<string, { type?: string; description?: string; default?: unknown }>; required?: string[] }
    const params = Object.entries(spec.properties ?? {})
      .map(([k, v]) => `${k}${spec.required?.includes(k) ? '' : '?'}: ${v.type ?? 'any'}${v.description ? ` (${v.description})` : ''}`)
      .join(', ')
    return `- ${t.name}(${params}): ${t.description}`
  }).join('\n')
}

export const jsonProtocol: ToolProtocol = {
  id: 'json',
  streamsText: false,
  instructions: (tools) =>
    [
      'Responde SIEMPRE con un único objeto JSON y nada más:',
      '- Para usar una herramienta: {"action":"tool","tool":"<nombre>","args":{…},"message":"qué vas a hacer, en una frase"}',
      '- Para terminar y responder al usuario: {"action":"final","message":"tu respuesta en español"}',
      'Usa UNA herramienta por respuesta. Herramientas disponibles:',
      describeTools(tools),
    ].join('\n'),
  request: (tools) => ({ format: jsonFormat(tools) }),
  parse: (content) => {
    let obj: { action?: string; tool?: string; args?: unknown; message?: string }
    try {
      obj = JSON.parse(content)
    } catch {
      return { text: '', calls: [], parseError: 'La respuesta no es un JSON válido. Responde solo con el objeto JSON indicado.' }
    }
    if (obj.action === 'final') return { text: String(obj.message ?? '').trim(), calls: [] }
    if (obj.action === 'tool' && obj.tool) return { text: String(obj.message ?? '').trim(), calls: [normalizeCall({ name: obj.tool, args: obj.args ?? {} })] }
    return { text: '', calls: [], parseError: 'Falta "action" ("tool" o "final") o el nombre de la herramienta.' }
  },
  assistantTurn: (content) => ({ role: 'assistant', content }),
  resultTurn: (call, output) => ({
    role: 'user',
    content: `Resultado de ${call.name}:\n${output}\n\nSi ya tienes lo necesario para responder o la tarea está hecha, responde {"action":"final","message":"…"}. Si no, usa la siguiente herramienta. Responde solo con JSON.`,
  }),
}
