import { describe, expect, it } from 'vitest'
import { OllamaClient } from '../../src/shared/ollama/client'
import { ModelService } from '../../src/main/services/models'

/** Descarga real desde Hugging Face (ZHASKA_EVAL_HF=1). Con los archivos ya en caché no vuelve a bajar nada. */
const MODEL = process.env['ZHASKA_EVAL_MODEL'] ?? 'gemma4:12b-it-qat'
const client = new OllamaClient(process.env['OLLAMA_HOST_URL'] ?? 'http://127.0.0.1:11434')

describe.skipIf(process.env['ZHASKA_EVAL_HF'] !== '1')('descarga real desde Hugging Face', () => {
  it(`instala ${MODEL} con herramientas y sin copias duplicadas`, async () => {
    const phases: string[] = []
    const last = await new Promise<{ phase: string; error: string | null; source: string }>((resolve) => {
      new ModelService(
        () => client,
        (p) => {
          if (phases.at(-1) !== p.phase) phases.push(p.phase)
          if (['done', 'error', 'cancelled'].includes(p.phase)) resolve(p)
        },
      ).pull(MODEL, 'huggingface')
    })
    console.log(`fases: ${phases.join(' → ')} · origen: ${last.source}${last.error ? ` · error: ${last.error}` : ''}`)
    expect(last.phase).toBe('done')
    const show = await client.show(MODEL)
    console.log(`capacidades: ${show.capabilities?.join(', ')}`)
    expect(show.capabilities).toEqual(expect.arrayContaining(['tools', 'thinking']))
    const names = (await client.tags()).models.map((m) => m.name)
    console.log(`modelos instalados: ${names.join(', ')}`)
    expect(names.some((n) => n.startsWith('hf.co/'))).toBe(false)
  })
})
