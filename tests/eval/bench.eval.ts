import os from 'node:os'
import { describe, expect, it } from 'vitest'
import { OllamaClient } from '../../src/shared/ollama/client'
import { runBench } from '../../src/agent/bench'

/** Banco de pruebas fuera de la app: ZHASKA_EVAL_MODEL=gemma4:12b-it-qat npm run eval:agent -- bench */
const MODEL = process.env['ZHASKA_EVAL_MODEL'] ?? 'gemma4:12b-it-qat'
const HOST = process.env['OLLAMA_HOST_URL'] ?? 'http://127.0.0.1:11434'
const ready = await new OllamaClient(HOST)
  .tags()
  .then((t) => t.models.some((m) => m.name === MODEL))
  .catch(() => false)

describe.skipIf(!ready)(`Banco de pruebas con ${MODEL}`, () => {
  it('mide carga, generación, prefill y llamadas a herramientas', async () => {
    const r = await runBench(HOST, MODEL, 32768, new AbortController().signal, (step, i, n) => console.log(`  [${i}/${n}] ${step}`))
    const f = (n: number, d = 1) => n.toLocaleString('es-ES', { maximumFractionDigits: d })
    console.log(
      `\n| Modelo | Equipo | GPU % | Carga | Generación | Prefill | Herram. nativas | Herram. JSON |\n|---|---|---|---|---|---|---|---|\n| \`${r.model}\` (ctx 32K) | ${os.cpus()[0]?.model} · ${Math.round(os.totalmem() / 1024 ** 3)} GB | ${r.gpuPercent ?? '—'} | ${f(r.loadMs / 1000)} s | ${f(r.genTokensPerSec)} tok/s | ${f(r.prefillTokensPerSec, 0)} tok/s | ${r.toolsNative ? `${r.toolsNative.valid}/${r.toolsNative.total}` : '—'} | ${r.toolsJson.valid}/${r.toolsJson.total} |\n`,
    )
    expect(r.genTokensPerSec).toBeGreaterThan(0)
  })
})
