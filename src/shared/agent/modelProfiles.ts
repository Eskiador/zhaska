/**
 * Perfiles de prompt por modelo (Fase 11). El agente es el mismo para cualquier modelo; lo que cambia con el
 * tamaño se decide MIDIENDO con la evaluación del agente (ROADMAP, Fase 11), no por intuición: la hipótesis
 * de que los modelos pequeños rinden mejor con instrucciones cortas resultó falsa con Gemma 4 E4B.
 */
export type PromptStyle = 'full' | 'compact'

export interface ModelProfile {
  id: string
  label: string
  style: PromptStyle
  /** core: sin herramientas de planificación ni de configuración (menos opciones para modelos pequeños) */
  tools: 'all' | 'core'
  /** Tope de temperatura: los modelos pequeños se desvían antes */
  maxTemperature: number
}

/**
 * Tamaño aproximado (miles de millones de parámetros) a partir del nombre del modelo. En los modelos MoE
 * (gemma4:26b-a4b) cuenta el tamaño total, que es lo que marca su capacidad, no los parámetros activos.
 */
export function modelSizeB(model: string): number | null {
  const m = model.toLowerCase()
  const eff = /[:-]e(\d+(?:\.\d+)?)b\b/.exec(m) // gemma4:e4b → 4
  if (eff) return Number(eff[1])
  const plain = /[:-](\d+(?:\.\d+)?)b\b/.exec(m) // gemma4:12b, qwen3:8b, gemma4:26b-a4b → 26
  if (plain) return Number(plain[1])
  return null
}

export function modelProfile(model: string, override?: PromptStyle): ModelProfile {
  const size = modelSizeB(model)
  const small = size !== null && size <= 5
  // Medido en la Fase 11 (7 tareas con gemma4:e4b-it-qat): prompt completo 6/7, compacto 4/7. El compacto hace
  // que el modelo pequeño se quede leyendo sin llegar a editar, así que TODOS usan el completo; el compacto se
  // conserva solo para poder volver a medirlo (ZHASKA_EVAL_PROMPT=compact).
  const style: PromptStyle = override ?? 'full'
  return {
    id: `${small ? 'pequeño' : 'estándar'}-${style}`,
    label: style === 'compact' ? 'Instrucciones compactas' : 'Instrucciones completas',
    style,
    tools: style === 'compact' ? 'core' : 'all',
    // Los modelos pequeños se desvían antes con temperaturas altas
    maxTemperature: small ? 0.15 : 1.5,
  }
}

/** Herramientas que no se ofrecen a los perfiles «core». */
export const NON_CORE_TOOLS = new Set(['update_plan', 'read_project_config', 'get_project_structure'])
