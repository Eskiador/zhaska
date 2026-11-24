import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { contextLengthOf, metricsOf, OllamaClient, OllamaError } from '../../src/shared/ollama/client'
import { OllamaProvider } from '../../src/agent/providers/ollama'
import { friendlyPullError, PullTracker, pullPhase } from '../../src/main/services/models'
import { toTurns } from '../../src/main/services/chat'
import { chatSystemPrompt, titleFromMessage } from '../../src/shared/agent/prompts'
import { estimateFit, GEMMA4_VARIANTS } from '../../src/shared/models/catalog'

/** Servidor falso de Ollama: respuestas NDJSON troceadas a propósito para probar el parser. */
let server: Server
let host = ''
let lastChatBody: Record<string, unknown> = {}

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const url = req.url ?? ''
      if (url === '/api/version') return res.end(JSON.stringify({ version: '0.30.8' }))
      if (url === '/api/ps') return res.end(JSON.stringify({ models: [] }))
      if (url === '/api/show') {
        const model = JSON.parse(body).model
        if (model === 'nope') {
          res.statusCode = 404
          return res.end(JSON.stringify({ error: `model '${model}' not found` }))
        }
        return res.end(JSON.stringify({ capabilities: ['completion', 'tools', 'thinking'], model_info: { 'general.architecture': 'gemma4', 'gemma4.context_length': 262144 } }))
      }
      if (url === '/api/chat') {
        lastChatBody = JSON.parse(body)
        res.setHeader('content-type', 'application/x-ndjson')
        const lines = [
          { model: 'm', message: { role: 'assistant', content: '', thinking: 'pensando…' }, done: false },
          { model: 'm', message: { role: 'assistant', content: 'Hola' }, done: false },
          { model: 'm', message: { role: 'assistant', content: ', mundo' }, done: false },
          { model: 'm', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', load_duration: 2e9, prompt_eval_count: 100, prompt_eval_duration: 5e8, eval_count: 30, eval_duration: 1e9, total_duration: 3.5e9 },
        ]
        const raw = lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
        // Enviar en trozos que cortan líneas por la mitad
        const parts = [raw.slice(0, 37), raw.slice(37, 120), raw.slice(120)]
        let i = 0
        const tick = () => {
          if (i < parts.length) {
            res.write(parts[i++])
            setTimeout(tick, 5)
          } else res.end()
        }
        return tick()
      }
      if (url === '/api/pull') {
        res.write(JSON.stringify({ status: 'pulling manifest' }) + '\n')
        res.write(JSON.stringify({ status: 'pulling abc', digest: 'abc', total: 100, completed: 50 }) + '\n')
        return res.end(JSON.stringify({ error: 'pull model manifest: file does not exist' }) + '\n')
      }
      res.statusCode = 404
      res.end('{}')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => server.close())

describe('OllamaClient', () => {
  it('lee versión y capacidades', async () => {
    const c = new OllamaClient(host)
    expect((await c.version()).version).toBe('0.30.8')
    expect(contextLengthOf(await c.show('gemma4:12b'))).toBe(262144)
  })

  it('reconstruye el streaming NDJSON aunque llegue troceado', async () => {
    const chunks = []
    for await (const ch of new OllamaClient(host).chat({ model: 'm', messages: [] })) chunks.push(ch)
    expect(chunks.map((c) => c.message?.content).join('')).toBe('Hola, mundo')
    const m = metricsOf(chunks.at(-1)!)
    expect(m).toMatchObject({ promptTokens: 100, evalTokens: 30, loadMs: 2000 })
    expect(m.tokensPerSec).toBeCloseTo(30)
    expect(m.prefillTokensPerSec).toBeCloseTo(200)
  })

  it('traduce errores: modelo inexistente, servidor caído y errores en mitad del stream', async () => {
    await expect(new OllamaClient(host).show('nope')).rejects.toMatchObject({ kind: 'not-found' })
    await expect(new OllamaClient('http://127.0.0.1:1').version(500)).rejects.toMatchObject({ kind: 'unavailable' })
    const pull = async () => {
      for await (const _ of new OllamaClient(host).pull('x')) void _
    }
    await expect(pull()).rejects.toBeInstanceOf(OllamaError)
  })

  it('cancela con AbortSignal', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(new OllamaClient(host).version()).resolves.toBeTruthy()
    const run = async () => {
      for await (const _ of new OllamaClient(host).chat({ model: 'm', messages: [] }, ctrl.signal)) void _
    }
    await expect(run()).rejects.toMatchObject({ kind: 'aborted' })
  })
})

describe('OllamaProvider', () => {
  it('normaliza fases y no deja salir el texto de razonamiento', async () => {
    const p = new OllamaProvider(new OllamaClient(host))
    const out = []
    for await (const c of p.chat({ model: 'gemma4:12b', messages: [{ role: 'user', content: 'hola' }], numCtx: 8192, temperature: 0.2, think: true }, new AbortController().signal)) out.push(c)
    expect(out.filter((c) => c.type === 'state').map((c) => (c as { state: string }).state)).toEqual(['loading', 'thinking', 'generating'])
    expect(out.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('')).toBe('Hola, mundo')
    expect(JSON.stringify(out)).not.toContain('pensando')
    expect(lastChatBody).toMatchObject({ think: true, options: { num_ctx: 8192, temperature: 0.2 }, stream: true })
  })
})

describe('progreso de descargas', () => {
  it('mapea los estados de /api/pull a las fases del diseño', () => {
    expect(pullPhase('pulling manifest')).toBe('manifest')
    expect(pullPhase('pulling 3a9f1c')).toBe('layers')
    expect(pullPhase('verifying sha256 digest')).toBe('verify')
    expect(pullPhase('writing manifest')).toBe('register')
    expect(pullPhase('success')).toBe('done')
  })

  it('explica en español los fallos de red al descargar', () => {
    expect(friendlyPullError('max retries exceeded: Get "https://x.r2.cloudflarestorage.com/…": dial tcp 172.64.66.1:443: i/o timeout')).toMatch(/servidor de descargas de Ollama/)
    expect(friendlyPullError('otro error')).toBe('otro error')
  })

  it('suma capas y calcula la velocidad', () => {
    const t = new PullTracker('j', 'gemma4:12b')
    t.update({ status: 'pulling a', digest: 'a', total: 1000, completed: 0 }, 0)
    t.update({ status: 'pulling b', digest: 'b', total: 1000, completed: 0 }, 0)
    const p = t.update({ status: 'pulling a', digest: 'a', total: 1000, completed: 500 }, 1000)
    expect(p).toMatchObject({ phase: 'layers', total: 2000, completed: 500 })
    expect(p.bytesPerSec).toBeCloseTo(500)
  })
})

describe('contexto del chat', () => {
  const msg = (role: 'user' | 'assistant', text: string, extra: unknown[] = []) => ({ id: text, conversationId: 'c', role, blocks: [{ kind: 'text', text }, ...extra], model: null, metrics: null, createdAt: 0 })

  it('conserva los turnos más recientes dentro del presupuesto e ignora bloques de error', () => {
    const msgs = [msg('user', 'a'.repeat(100)), msg('assistant', 'b'.repeat(100)), msg('user', 'último', [{ kind: 'error', message: 'x' }])]
    expect(toTurns(msgs, 1000).map((t) => t.role)).toEqual(['user', 'assistant', 'user'])
    expect(toTurns(msgs, 150).map((t) => t.content)).toEqual(['b'.repeat(100), 'último'])
  })

  it('genera títulos y un prompt honesto sobre lo que aún no puede hacer', () => {
    expect(titleFromMessage('  Arregla el login\nmás detalles')).toBe('Arregla el login')
    expect(titleFromMessage('x'.repeat(100))).toHaveLength(58)
    const p = chatSystemPrompt({ projectName: 'demo', tree: ['src/', 'package.json'], guide: null })
    expect(p).toContain('no tienes herramientas')
    expect(p).toContain('src/, package.json')
  })
})

describe('recomendación de modelos', () => {
  const v = (tag: string) => GEMMA4_VARIANTS.find((x) => x.tag === tag)!
  it('RTX 5060 8 GB + 16 GB RAM', () => {
    const hw = { vramGB: 8, ramGB: 16, gpu: 'RTX 5060' }
    expect(estimateFit(v('gemma4:e4b-it-qat'), hw)).toBe('gpu')
    expect(estimateFit(v('gemma4:12b-it-qat'), hw)).toBe('partial')
    expect(estimateFit(v('gemma4:26b-a4b-it-qat'), hw)).toBe('no-memory')
  })
})

describe('descarga alternativa desde Hugging Face', () => {
  it('si el servidor de Ollama no responde, descarga de Hugging Face, prepara el modelo y limpia la copia', async () => {
    const { ModelService } = await import('../../src/main/services/models')
    const calls: { url: string; body: Record<string, unknown> }[] = []
    const srv = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const b = body ? JSON.parse(body) : {}
        calls.push({ url: req.url ?? '', body: b })
        if (req.url === '/api/pull' && b.model === 'gemma4:12b-it-qat') {
          res.write(JSON.stringify({ status: 'pulling manifest' }) + '\n')
          return res.end(JSON.stringify({ error: 'max retries exceeded: Get "https://x.r2.cloudflarestorage.com/…": dial tcp 172.64.66.1:443: i/o timeout' }) + '\n')
        }
        if (req.url === '/api/pull') {
          res.write(JSON.stringify({ status: 'pulling manifest' }) + '\n')
          res.write(JSON.stringify({ status: 'pulling abc', digest: 'abc', total: 100, completed: 100 }) + '\n')
          return res.end(JSON.stringify({ status: 'success' }) + '\n')
        }
        res.end(JSON.stringify({ status: 'success' }))
      })
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    const fakeHost = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`
    const events: { phase: string; source: string }[] = []
    let resolveDone: () => void
    const done = new Promise<void>((r) => (resolveDone = r))
    const svc = new ModelService(
      () => new OllamaClient(fakeHost),
      (p) => {
        events.push({ phase: p.phase, source: p.source })
        if (['done', 'error'].includes(p.phase)) resolveDone()
      },
    )
    svc.pull('gemma4:12b-it-qat', 'auto')
    await done
    srv.close()
    expect(events.at(-1)).toEqual({ phase: 'done', source: 'huggingface' })
    const pulls = calls.filter((c) => c.url === '/api/pull').map((c) => c.body.model)
    expect(pulls).toEqual(['gemma4:12b-it-qat', 'hf.co/google/gemma-4-12B-it-qat-q4_0-gguf:latest'])
    expect(calls.find((c) => c.url === '/api/create')?.body).toMatchObject({ model: 'gemma4:12b-it-qat', from: 'hf.co/google/gemma-4-12B-it-qat-q4_0-gguf:latest', renderer: 'gemma4', parser: 'gemma4' })
    expect(calls.find((c) => c.url === '/api/delete')?.body).toEqual({ model: 'hf.co/google/gemma-4-12B-it-qat-q4_0-gguf:latest' })
  })

  it('con "Solo Ollama" no cambia de origen y explica el error', async () => {
    const { ModelService } = await import('../../src/main/services/models')
    const srv = createServer((_req, res) => res.end(JSON.stringify({ error: 'dial tcp 1.2.3.4:443: i/o timeout' }) + '\n'))
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    const fakeHost = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`
    const last = await new Promise<{ phase: string; error: string | null }>((resolve) => {
      new ModelService(
        () => new OllamaClient(fakeHost),
        (p) => ['done', 'error'].includes(p.phase) && resolve(p),
      ).pull('gemma4:12b-it-qat', 'ollama')
    })
    srv.close()
    expect(last.phase).toBe('error')
    expect(last.error).toMatch(/servidor de descargas de Ollama/)
  })
})
