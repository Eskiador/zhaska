import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Evaluación del agente con un modelo real de Ollama: ZHASKA_EVAL_MODEL=gemma4:12b-it-qat npm run eval:agent
export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared'), '@core': resolve('src/core') } },
  test: { include: ['tests/eval/**/*.eval.ts'], environment: 'node', testTimeout: 600_000, hookTimeout: 60_000, fileParallelism: false },
})
