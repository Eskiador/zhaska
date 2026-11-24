import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { OllamaClient } from '../../src/shared/ollama/client'
import { OllamaProvider } from '../../src/agent/providers/ollama'
import { AgentLoop, type AgentTaskSpec } from '../../src/agent/engine/loop'
import { defaultShell } from '../../src/core/commands/runner'

/**
 * Tareas reales para el criterio de salida de la Fase 5 (≥ 80 % de éxito con el modelo por defecto).
 * Cada tarea parte de un proyecto pequeño en una carpeta temporal y se comprueba el resultado en disco.
 */
const MODEL = process.env['ZHASKA_EVAL_MODEL'] ?? 'gemma4:12b-it-qat'
const HOST = process.env['OLLAMA_HOST_URL'] ?? 'http://127.0.0.1:11434'
const results: { task: string; ok: boolean; steps: number; seconds: number; note: string }[] = []

interface Task {
  name: string
  files: Record<string, string>
  prompt: string
  check: (root: string, text: string) => boolean
  /** Adjunto (Fase 8): texto largo; solo el principio va en el mensaje y el resto se lee con read_attachment */
  attachment?: { name: string; text: string; inline: number }
}

const TASKS: Task[] = [
  {
    name: 'Crear un archivo',
    files: { 'README.md': '# demo\n' },
    prompt: 'Crea el archivo notas/ideas.md con un título "# Ideas" y una lista con dos ideas cualquiera.',
    check: (r) => existsSync(join(r, 'notas/ideas.md')) && /#\s*Ideas/.test(readFileSync(join(r, 'notas/ideas.md'), 'utf8')),
  },
  {
    name: 'Editar un valor',
    files: { 'src/config.js': "export const config = {\n  port: 3000,\n  name: 'demo',\n}\n" },
    prompt: 'Cambia el puerto de la configuración en src/config.js a 8080.',
    check: (r) => /port:\s*8080/.test(readFileSync(join(r, 'src/config.js'), 'utf8')) && /name: 'demo'/.test(readFileSync(join(r, 'src/config.js'), 'utf8')),
  },
  {
    name: 'Corregir un error',
    files: { 'src/math.js': 'export function suma(a, b) {\n  return a - b\n}\n\nexport function doble(x) {\n  return x * 2\n}\n' },
    prompt: 'La función suma de src/math.js devuelve resultados incorrectos. Encuentra el error y corrígelo.',
    check: (r) => /return\s+a\s*\+\s*b/.test(readFileSync(join(r, 'src/math.js'), 'utf8')) && /x \* 2/.test(readFileSync(join(r, 'src/math.js'), 'utf8')),
  },
  {
    name: 'Renombrar en dos archivos',
    files: {
      'src/utils.js': 'export function calc(precio) {\n  return precio * 1.21\n}\n',
      'src/index.js': "import { calc } from './utils.js'\n\nconsole.log(calc(100))\n",
    },
    prompt: 'Renombra la función calc a conIva en src/utils.js y actualiza su uso en src/index.js.',
    check: (r) => {
      const u = readFileSync(join(r, 'src/utils.js'), 'utf8')
      const i = readFileSync(join(r, 'src/index.js'), 'utf8')
      return /function conIva/.test(u) && /conIva\(100\)/.test(i) && /import \{ conIva \}/.test(i) && !/calc/.test(u + i)
    },
  },
  {
    name: 'Editar package.json',
    files: { 'package.json': '{\n  "name": "demo",\n  "version": "1.4.2",\n  "scripts": {\n    "build": "node build.js"\n  }\n}\n' },
    prompt: 'Añade a package.json un script "start" que ejecute "node src/index.js", sin quitar los demás.',
    check: (r) => {
      try {
        const p = JSON.parse(readFileSync(join(r, 'package.json'), 'utf8'))
        return p.scripts?.start === 'node src/index.js' && p.scripts?.build === 'node build.js'
      } catch {
        return false
      }
    },
  },
  {
    name: 'Leer un adjunto largo (read_attachment)',
    files: { 'README.md': '# demo\n' },
    prompt: '¿Cuál es el código de activación que aparece al final del adjunto manual.txt? Responde solo con el código.',
    attachment: { name: 'manual.txt', text: `${'Sección de relleno sin datos importantes.\n'.repeat(900)}Código de activación: ZX-7781-QK\n`, inline: 3000 },
    check: (_r, text) => text.includes('ZX-7781-QK'),
  },
  {
    name: 'Responder leyendo el proyecto',
    files: { 'package.json': '{\n  "name": "tienda",\n  "version": "3.7.1"\n}\n', 'src/app.js': 'console.log(1)\n' },
    prompt: '¿Qué versión tiene este proyecto según su package.json? Responde con el número de versión.',
    check: (_r, text) => text.includes('3.7.1'),
  },
]

async function available(): Promise<boolean> {
  try {
    const tags = await new OllamaClient(HOST).tags()
    return tags.models.some((m) => m.name === MODEL || m.name === `${MODEL}:latest`)
  } catch {
    return false
  }
}

const ready = await available()

describe.skipIf(!ready)(`Evaluación del agente con ${MODEL}`, () => {
  for (const task of TASKS) {
    it(task.name, async () => {
      const root = mkdtempSync(join(tmpdir(), 'zh-eval-'))
      for (const [rel, content] of Object.entries(task.files)) {
        mkdirSync(join(root, rel, '..'), { recursive: true })
        writeFileSync(join(root, rel), content)
      }
      const spec: AgentTaskSpec = {
        taskId: task.name,
        model: MODEL,
        root,
        projectName: 'demo',
        userMessage: task.prompt,
        history: [],
        numCtx: 16384,
        temperature: 0.1,
        think: false,
        maxSteps: 20,
        protocol: (process.env['ZHASKA_EVAL_PROTOCOL'] as AgentTaskSpec['protocol']) ?? 'auto',
        autonomy: 'autonomous',
        permissions: { read: 'allow', write: 'allow', execute: 'allow', install: 'block', internet: 'block' },
        rules: [],
        protectedPatterns: ['.env*'],
        autoVerify: false,
        shell: defaultShell('powershell'),
        blobDir: join(root, '..', `${root.split(/[\\/]/).pop()}-blobs`),
        // Comparar estilos de prompt con el mismo modelo (Fase 11): ZHASKA_EVAL_PROMPT=full|compact
        promptStyle: (process.env['ZHASKA_EVAL_PROMPT'] as AgentTaskSpec['promptStyle']) || undefined,
      }
      if (task.attachment) {
        const textFile = join(root, '..', `${root.split(/[\\/]/).pop()}-${task.attachment.name}`)
        writeFileSync(textFile, task.attachment.text)
        const a = task.attachment
        spec.attachments = [{ id: 'att-1', name: a.name, kind: 'text', textFile, unzipDir: null, chars: a.text.length }]
        spec.attachmentNames = [a.name]
        spec.attachmentContext = `Adjuntos del usuario (1). Son contexto de solo lectura y NO forman parte del proyecto; puedes volver a leerlos con read_attachment:\n\n[Adjunto 1] ${a.name} · texto · ${a.text.length} caracteres\n${a.text.slice(0, a.inline)}\n… (recortado: ${a.text.length - a.inline} caracteres más; usa read_attachment con name="${a.name}" y offset=${a.inline} para leer el resto)`
      }
      const t0 = Date.now()
      const loop = new AgentLoop(spec, { provider: new OllamaProvider(new OllamaClient(HOST)), emit: () => {}, text: () => {}, askApproval: async () => 'allow_once', onChange: () => {}, onRule: () => {} })
      const r = await loop.run(new AbortController().signal)
      if (process.env['ZHASKA_EVAL_TRACE']) writeFileSync(join(process.env['ZHASKA_EVAL_TRACE'], `${task.name.replace(/[^\w]+/g, '-')}.json`), JSON.stringify((loop as unknown as { messages: unknown[] }).messages, null, 1))
      const ok = r.status === 'completed' && task.check(root, r.text)
      results.push({ task: task.name, ok, steps: r.steps.length, seconds: Math.round((Date.now() - t0) / 1000), note: r.error ?? r.steps.map((s) => s.tool).join('→') })
      if (!ok) {
        // Para diagnosticar: estado final de los archivos de la tarea
        for (const rel of Object.keys(task.files)) console.log(`--- ${task.name} · ${rel}\n${existsSync(join(root, rel)) ? readFileSync(join(root, rel), 'utf8') : '(no existe)'}`)
      }
      expect.soft(ok, `${task.name}: ${r.status} ${r.error ?? ''}`).toBe(true)
    })
  }

  afterAll(() => {
    const passed = results.filter((r) => r.ok).length
    console.log(`\nModelo: ${MODEL} · prompt: ${process.env['ZHASKA_EVAL_PROMPT'] || 'según el modelo'}\n${results.map((r) => `${r.ok ? '✓' : '✗'} ${r.task} · ${r.steps} pasos · ${r.seconds} s · ${r.note}`).join('\n')}\nÉxito: ${passed}/${results.length} (${Math.round((passed / results.length) * 100)} %)\n`)
  })
})
