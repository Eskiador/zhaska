/**
 * Agent Host (utilityProcess). Ejecuta el trabajo con modelos fuera del proceso principal:
 * si se bloquea o falla, la interfaz sigue respondiendo y main lo reinicia.
 * Fase 4: chat con streaming y banco de pruebas. Fase 5: bucle del agente y herramientas.
 */
import { OllamaClient, OllamaError } from '@shared/ollama/client'
import type { HostEvent, HostRequest } from '@shared/agent/host'
import { OllamaProvider } from './providers/ollama'
import { runBench } from './bench'
import { AgentLoop, type Decision } from './engine/loop'

const port = process.parentPort
const send = (e: HostEvent) => port.postMessage(e)
const running = new Map<string, AbortController>()
const approvals = new Map<string, (d: Decision) => void>()
/** Pausa real: el bucle se detiene antes del siguiente paso hasta que se reanude */
const paused = new Map<string, { resume: Promise<void>; release: () => void }>()
const sendEvent = (taskId: string, event: Record<string, unknown>) => send({ type: 'agent.event', taskId, event: { ...event, ts: Date.now() } as never })
const providers = new Map<string, OllamaProvider>()
const providerFor = (host: string) => {
  let p = providers.get(host)
  if (!p) providers.set(host, (p = new OllamaProvider(new OllamaClient(host))))
  return p
}

port.on('message', (e) => {
  const req = e.data as HostRequest
  switch (req.type) {
    case 'chat.start':
      void runChat(req)
      break
    case 'chat.cancel':
    case 'agent.cancel':
    case 'bench.cancel':
      running.get(req.type === 'bench.cancel' ? req.jobId : req.taskId)?.abort()
      break
    case 'agent.approval':
      approvals.get(req.requestId)?.(req.decision)
      approvals.delete(req.requestId)
      break
    case 'agent.start':
      void runAgent(req)
      break
    case 'agent.pause':
      if (running.has(req.taskId) && !paused.has(req.taskId)) {
        let release!: () => void
        const resume = new Promise<void>((r) => (release = r))
        paused.set(req.taskId, { resume, release })
        sendEvent(req.taskId, { type: 'task.paused' })
      }
      break
    case 'agent.resume': {
      const p = paused.get(req.taskId)
      if (p) {
        paused.delete(req.taskId)
        p.release()
        sendEvent(req.taskId, { type: 'task.resumed' })
      }
      break
    }
    case 'bench.start': {
      const ctrl = new AbortController()
      running.set(req.jobId, ctrl)
      runBench(req.host, req.model, req.numCtx, ctrl.signal, (step, index, total) => send({ type: 'bench.progress', jobId: req.jobId, step, index, total }))
        .then((result) => send({ type: 'bench.done', jobId: req.jobId, result }))
        .catch((err: unknown) => send({ type: 'bench.error', jobId: req.jobId, message: ctrl.signal.aborted ? 'Cancelado' : (err as Error).message }))
        .finally(() => running.delete(req.jobId))
      break
    }
  }
})

async function runChat(req: Extract<HostRequest, { type: 'chat.start' }>) {
  const ctrl = new AbortController()
  running.set(req.taskId, ctrl)
  let text = ''
  try {
    for await (const chunk of providerFor(req.host).chat({ model: req.model, messages: req.messages, numCtx: req.numCtx, temperature: req.temperature, think: req.think }, ctrl.signal)) {
      if (chunk.type === 'state') send({ type: 'chat.state', taskId: req.taskId, state: chunk.state })
      else if (chunk.type === 'text') {
        text += chunk.text
        send({ type: 'chat.delta', taskId: req.taskId, text: chunk.text })
      } else send({ type: 'chat.done', taskId: req.taskId, text, metrics: chunk.metrics, doneReason: chunk.doneReason })
    }
  } catch (err) {
    if (ctrl.signal.aborted) send({ type: 'chat.cancelled', taskId: req.taskId, text })
    else {
      const e = err as OllamaError
      const code = e.kind === 'unavailable' ? 'OLLAMA_UNAVAILABLE' : e.kind === 'not-found' ? 'MODEL_NOT_FOUND' : 'MODEL_ERROR'
      send({ type: 'chat.error', taskId: req.taskId, code, message: e.message ?? String(err), text })
    }
  } finally {
    running.delete(req.taskId)
  }
}

async function runAgent(req: Extract<HostRequest, { type: 'agent.start' }>) {
  const { taskId } = req.spec
  const ctrl = new AbortController()
  running.set(taskId, ctrl)
  try {
    const loop = new AgentLoop(req.spec, {
      provider: providerFor(req.host),
      emit: (event) => send({ type: 'agent.event', taskId, event: { ...event, ts: Date.now() } as never }),
      text: (text) => send({ type: 'agent.text', taskId, text }),
      askApproval: (r) => new Promise<Decision>((resolve) => approvals.set(r.requestId, resolve)),
      onChange: (change) => send({ type: 'agent.change', taskId, change }),
      onRule: (rule) => send({ type: 'agent.rule', taskId, rule }),
      waitIfPaused: async (signal) => {
        const p = paused.get(taskId)
        if (!p) return
        sendEvent(taskId, { type: 'model.state', state: 'paused' })
        await Promise.race([p.resume, new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }))])
      },
    })
    const result = await loop.run(ctrl.signal)
    send({ type: 'agent.done', taskId, result })
  } catch (err) {
    send({ type: 'agent.done', taskId, result: { status: 'failed', text: '', error: (err as Error).message, steps: [], metrics: { promptTokens: 0, evalTokens: 0, steps: 0, lastTokensPerSec: 0 } } })
  } finally {
    running.delete(taskId)
    paused.get(taskId)?.release()
    paused.delete(taskId)
  }
}

send({ type: 'ready' })
