import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { OllamaClient } from '../../src/shared/ollama/client'
import { OllamaProvider } from '../../src/agent/providers/ollama'
import { AgentLoop, type AgentTaskSpec } from '../../src/agent/engine/loop'
import type { ChatTurn } from '../../src/shared/agent/host'
import { defaultShell } from '../../src/core/commands/runner'

/**
 * Prueba de larga duración del agente (Fase 11): una conversación de tres tareas encadenadas sobre el mismo
 * proyecto, con pruebas reales (node --test, sin dependencias ni red). Se comprueba el resultado en disco con
 * pruebas OCULTAS propias (no las que escribe el agente), y se miden pasos, tiempo, tokens y memoria.
 *   ZHASKA_EVAL_MODEL=gemma4:12b-it-qat npm run eval:agent -- tests/eval/long.eval.ts
 */
const MODEL = process.env['ZHASKA_EVAL_MODEL'] ?? 'gemma4:12b-it-qat'
const HOST = process.env['OLLAMA_HOST_URL'] ?? 'http://127.0.0.1:11434'

const FILES: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'inventario', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n',
  'src/inventario.js': `export function crearInventario() {
  return []
}

export function anadir(inv, nombre, cantidad, precio) {
  inv.push({ nombre, cantidad, precio })
  return inv
}

/** Valor total del inventario (cantidad × precio de cada producto) */
export function total(inv) {
  return inv.reduce((suma, p) => suma + p.precio, 0)
}

// TODO: devuelve los productos cuya cantidad es menor que \`minimo\`
export function bajoStock(inv, minimo) {
  throw new Error('Sin implementar')
}

// TODO: quita \`cantidad\` unidades del producto \`nombre\`. Si no existe o no hay suficientes, lanza un Error
export function retirar(inv, nombre, cantidad) {
  throw new Error('Sin implementar')
}
`,
  'test/inventario.test.js': `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { crearInventario, anadir, total } from '../src/inventario.js'

test('añadir productos', () => {
  const inv = anadir(crearInventario(), 'tornillo', 10, 0.5)
  assert.equal(inv.length, 1)
})

test('total del inventario', () => {
  const inv = crearInventario()
  anadir(inv, 'tornillo', 10, 0.5)
  anadir(inv, 'tuerca', 4, 0.25)
  assert.equal(total(inv), 6)
})
`,
}

/** Pruebas ocultas: lo que de verdad pedimos, independientemente de las pruebas que escriba el agente. */
const HIDDEN = (step: number) => `import assert from 'node:assert/strict'
import * as m from './src/inventario.js'
const inv = m.crearInventario()
m.anadir(inv, 'tornillo', 10, 0.5)
m.anadir(inv, 'tuerca', 2, 0.25)
m.anadir(inv, 'arandela', 1, 0.1)
assert.equal(m.total(inv), 5.6)
assert.deepEqual(m.bajoStock(inv, 3).map((p) => p.nombre).sort(), ['arandela', 'tuerca'])
m.retirar(inv, 'tornillo', 4)
assert.equal(inv.find((p) => p.nombre === 'tornillo').cantidad, 6)
assert.throws(() => m.retirar(inv, 'tuerca', 5))
assert.throws(() => m.retirar(inv, 'no-existe', 1))
${step >= 2 ? "const v = m.valorPorProducto(inv)\nassert.equal(Math.round(v.tornillo * 100), 300)\nassert.equal(Math.round(v.tuerca * 100), 50)" : ''}
console.log('ocultas-ok')
`

const TASKS = [
  {
    name: '1 · corregir, implementar y probar',
    prompt:
      'En src/inventario.js la función total da un resultado incorrecto y hay dos funciones sin implementar (bajoStock y retirar; mira los comentarios TODO). Corrige total, implementa las dos funciones, añade pruebas para bajoStock y retirar en test/inventario.test.js y ejecuta las pruebas hasta que todas pasen. Al terminar, resume lo que hiciste.',
  },
  {
    name: '2 · ampliar con historial',
    prompt: 'Ahora añade a src/inventario.js una función valorPorProducto(inv) que devuelva un objeto { nombre: cantidad × precio } para cada producto, con sus pruebas, y comprueba que todas las pruebas siguen pasando.',
  },
  {
    name: '3 · documentar',
    prompt: 'Crea un README.md que explique cada función del módulo (incluida valorPorProducto) con un ejemplo de uso y cómo ejecutar las pruebas.',
  },
]

async function available(): Promise<boolean> {
  try {
    return (await new OllamaClient(HOST).tags()).models.some((m) => m.name === MODEL)
  } catch {
    return false
  }
}

const ready = await available()
const report: string[] = []

describe.skipIf(!ready)(`Larga duración con ${MODEL}`, () => {
  const root = mkdtempSync(join(tmpdir(), 'zh-largo-'))
  for (const [rel, content] of Object.entries(FILES)) {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
  const history: ChatTurn[] = []
  const run = (cmd: string, args: string[]) => {
    try {
      return { ok: true, out: execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: 'pipe', timeout: 60_000 }) }
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string }
      return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
    }
  }

  TASKS.forEach((task, i) => {
    it(task.name, async () => {
      const spec: AgentTaskSpec = {
        taskId: `largo-${i}`,
        model: MODEL,
        root,
        projectName: 'inventario',
        userMessage: task.prompt,
        history: [...history],
        numCtx: 32768,
        temperature: 0.1,
        think: false,
        maxSteps: 40,
        protocol: 'auto',
        autonomy: 'autonomous',
        permissions: { read: 'allow', write: 'allow', execute: 'allow', install: 'block', internet: 'block' },
        rules: [],
        protectedPatterns: ['.env*'],
        autoVerify: true,
        shell: defaultShell('powershell'),
        blobDir: join(root, '..', `${root.split(/[\\/]/).pop()}-blobs`),
        // Comparar estilos de prompt con el mismo modelo (Fase 11): ZHASKA_EVAL_PROMPT=full|compact
        promptStyle: (process.env['ZHASKA_EVAL_PROMPT'] as AgentTaskSpec['promptStyle']) || undefined,
      }
      const heap0 = process.memoryUsage().heapUsed
      const t0 = Date.now()
      const loop = new AgentLoop(spec, { provider: new OllamaProvider(new OllamaClient(HOST)), emit: () => {}, text: () => {}, askApproval: async () => 'allow_once', onChange: () => {}, onRule: () => {} })
      const r = await loop.run(new AbortController().signal)
      // Para diagnosticar: la conversación completa con el modelo (llamadas y resultados)
      if (process.env['ZHASKA_EVAL_TRACE']) writeFileSync(join(process.env['ZHASKA_EVAL_TRACE'], `largo-${i + 1}.json`), JSON.stringify((loop as unknown as { messages: unknown[] }).messages, null, 1))
      const seconds = Math.round((Date.now() - t0) / 1000)
      const heapMB = Math.round((process.memoryUsage().heapUsed - heap0) / 1024 / 1024)
      history.push({ role: 'user', content: task.prompt }, { role: 'assistant', content: r.text })

      // Comprobación independiente
      const tests = run('node', ['--test'])
      writeFileSync(join(root, 'ocultas.mjs'), HIDDEN(i + 1))
      const hidden = run('node', ['ocultas.mjs'])
      const testFile = readFileSync(join(root, 'test/inventario.test.js'), 'utf8')
      let ok = r.status === 'completed' && tests.ok && hidden.ok
      if (i === 0) ok &&= /bajoStock/.test(testFile) && /retirar/.test(testFile)
      if (i === 1) ok &&= /valorPorProducto/.test(testFile)
      if (i === 2) ok &&= existsSync(join(root, 'README.md')) && ['total', 'bajoStock', 'retirar', 'valorPorProducto'].every((f) => readFileSync(join(root, 'README.md'), 'utf8').includes(f))
      const failed = r.steps.filter((s) => !s.ok).length
      report.push(
        `${ok ? '✓' : '✗'} ${task.name} · ${r.steps.length} pasos (${failed} fallidos) · ${seconds} s · ${r.metrics.promptTokens.toLocaleString('es-ES')} tokens leídos, ${r.metrics.evalTokens.toLocaleString('es-ES')} generados · ${r.metrics.lastTokensPerSec.toFixed(1)} tok/s · memoria +${heapMB} MB\n    ${r.steps.map((s) => `${s.tool}${s.ok ? '' : '✗'}`).join(' → ')}${r.error ? `\n    ${r.error}` : ''}${!tests.ok ? `\n    pruebas del proyecto: ${tests.out.split('\n').filter((l) => /not ok|fail/i.test(l)).slice(0, 3).join(' | ')}` : ''}${!hidden.ok ? `\n    pruebas ocultas: ${hidden.out.split('\n').find((l) => /Error|assert/i.test(l)) ?? hidden.out.slice(0, 200)}` : ''}`,
      )
      expect.soft(ok, `${task.name}: ${r.status} ${r.error ?? ''}`).toBe(true)
    })
  })

  afterAll(() => {
    console.log(`\nModelo: ${MODEL}\n${report.join('\n')}\n`)
  })
})
