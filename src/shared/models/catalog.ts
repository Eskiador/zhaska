/**
 * Catálogo de variantes de Gemma 4 publicadas en Ollama (ollama.com/library/gemma4/tags, 22-11-2026).
 * Son datos reales de la biblioteca, no de demostración. En la Fase 4 las capacidades se leerán
 * de `/api/show` del modelo instalado; este catálogo solo sirve para recomendar y descargar.
 */

export interface ModelVariant {
  tag: string
  family: 'gemma4'
  size: 'E2B' | 'E4B' | '12B' | '26B A4B' | '31B'
  quant: 'QAT' | 'Q4_K_M' | 'Q8_0'
  downloadGB: number
  contextK: number
  capabilities: { tools: boolean; vision: boolean; thinking: boolean; audio: boolean }
  profile?: 'fast' | 'balanced' | 'quality'
  note: string
  /** Repositorio oficial de Google en Hugging Face con los mismos pesos (descarga alternativa) */
  hfRepo?: string
}

const caps = (audio = false) => ({ tools: true, vision: true, thinking: true, audio })

export const GEMMA4_VARIANTS: ModelVariant[] = [
  { tag: 'gemma4:e2b-it-qat', family: 'gemma4', size: 'E2B', quant: 'QAT', downloadGB: 4.3, contextK: 128, capabilities: caps(true), note: 'Muy rápido. Útil para tareas auxiliares (títulos, resúmenes).' , hfRepo: 'google/gemma-4-E2B-it-qat-q4_0-gguf' },
  { tag: 'gemma4:e4b-it-qat', family: 'gemma4', size: 'E4B', quant: 'QAT', downloadGB: 6.1, contextK: 128, capabilities: caps(true), profile: 'fast', note: 'Cabe entero en GPU. Respuestas rápidas y tareas pequeñas.' , hfRepo: 'google/gemma-4-E4B-it-qat-q4_0-gguf' },
  { tag: 'gemma4:12b-it-qat', family: 'gemma4', size: '12B', quant: 'QAT', downloadGB: 7.2, contextK: 256, capabilities: caps(), profile: 'balanced', note: 'Mejor calidad que cabe casi entera en 8 GB de VRAM.' , hfRepo: 'google/gemma-4-12B-it-qat-q4_0-gguf' },
  { tag: 'gemma4:12b-it-q4_K_M', family: 'gemma4', size: '12B', quant: 'Q4_K_M', downloadGB: 8.0, contextK: 256, capabilities: caps(), note: 'Cuantización clásica; algo mayor que QAT sin ventaja clara.' },
  { tag: 'gemma4:26b-a4b-it-qat', family: 'gemma4', size: '26B A4B', quant: 'QAT', downloadGB: 16, contextK: 256, capabilities: caps(), profile: 'quality', note: 'MoE (~4B activos). Requiere ≥ 32 GB de RAM con 8 GB de VRAM.' , hfRepo: 'google/gemma-4-26B-A4B-it-qat-q4_0-gguf' },
  { tag: 'gemma4:31b-it-qat', family: 'gemma4', size: '31B', quant: 'QAT', downloadGB: 19, contextK: 256, capabilities: caps(), note: 'Denso. Demasiado lento con 8 GB de VRAM.' , hfRepo: 'google/gemma-4-31B-it-qat-q4_0-gguf' },
]

export interface Hardware {
  vramGB: number
  ramGB: number
  gpu: string
  /** Memoria unificada (Apple Silicon): GPU y CPU comparten la misma RAM */
  unified?: boolean
}

/** Equipo de referencia del proyecto. La detección automática llega en la Fase 4. */
export const REFERENCE_HARDWARE: Hardware = { vramGB: 8, ramGB: 16, gpu: 'NVIDIA RTX 5060' }

export type Fit = 'gpu' | 'partial' | 'tight' | 'too-slow' | 'no-memory'

/**
 * Estimación conservadora de encaje (la medición real la da el banco de pruebas).
 * GPU dedicada: VRAM útil ≈ VRAM − 0,8 GB (escritorio); RAM disponible para el modelo ≈ RAM − 6 GB (sistema + app).
 * Memoria unificada: la GPU puede usar ≈ 2/3 de la RAM; por encima, muy justo hasta RAM − 3 GB.
 */
export function estimateFit(v: ModelVariant, hw: Hardware): Fit {
  const need = v.downloadGB * 1.1 // + caché KV y buffers con num_ctx 32K
  if (hw.unified) {
    if (need <= hw.vramGB) return 'gpu'
    return need <= hw.ramGB - 3 ? 'tight' : 'no-memory'
  }
  const vram = hw.vramGB - 0.8
  const ramFree = hw.ramGB - 6
  if (need <= vram) return 'gpu'
  const spill = need - vram
  if (spill > ramFree) return 'no-memory'
  if (v.size === '31B') return 'too-slow'
  return spill > ramFree * 0.5 ? 'tight' : 'partial'
}

/** Variante recomendada: la de más calidad que cabe sin quedar "muy justa". */
export function recommendVariant(hw: Hardware): ModelVariant {
  const order = ['gemma4:12b-it-qat', 'gemma4:e4b-it-qat', 'gemma4:e2b-it-qat']
  return GEMMA4_VARIANTS.find((v) => order.includes(v.tag) && ['gpu', 'partial'].includes(estimateFit(v, hw))) ?? GEMMA4_VARIANTS.find((v) => v.tag === 'gemma4:e2b-it-qat')!
}

export const FIT_LABEL: Record<Fit, string> = {
  gpu: 'Cabe en GPU',
  partial: 'GPU + RAM',
  tight: 'Muy justo',
  'too-slow': 'Muy lento',
  'no-memory': 'Memoria insuficiente',
}
