import { parentPort } from 'node:worker_threads'
import { extract, ExtractError, type ExtractJob } from './extract'

/**
 * Proceso de extracción (ARCHITECTURE §8): PDF, OCR, hojas de cálculo y ZIP pueden tardar segundos y usar
 * mucha CPU; aquí no bloquean el proceso principal ni la interfaz. Un trabajo cada vez.
 * En Electron se lanza como utilityProcess (Fase 10: lee el ASAR de la app instalada y, si un archivo
 * malicioso lo tumba, no arrastra al proceso principal); también funciona como worker_thread.
 */
export type WorkerRequest = { id: string; job: ExtractJob }
export type WorkerMessage =
  | { type: 'progress'; id: string; message: string }
  | { type: 'done'; id: string; result: Awaited<ReturnType<typeof extract>> }
  | { type: 'error'; id: string; message: string; expected: boolean }

interface Port {
  on(event: 'message', fn: (m: WorkerRequest) => void): void
  postMessage(m: WorkerMessage): void
}
type UtilityParent = { on(event: 'message', fn: (e: { data: WorkerRequest }) => void): void; postMessage(m: unknown): void }
const utility = (process as unknown as { parentPort?: UtilityParent }).parentPort
const port: Port = utility ? { on: (_e, fn) => utility.on('message', (e) => fn(e.data)), postMessage: (m) => utility.postMessage(m) } : (parentPort as unknown as Port)
let queue = Promise.resolve()

port.on('message', (req: WorkerRequest) => {
  queue = queue.then(async () => {
    try {
      const result = await extract(req.job, (message) => port.postMessage({ type: 'progress', id: req.id, message } satisfies WorkerMessage))
      port.postMessage({ type: 'done', id: req.id, result } satisfies WorkerMessage)
    } catch (e) {
      port.postMessage({ type: 'error', id: req.id, message: (e as Error).message, expected: e instanceof ExtractError } satisfies WorkerMessage)
    }
  })
})
