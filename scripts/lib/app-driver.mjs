/**
 * Arranca la app EMPAQUETADA y la controla desde fuera con el protocolo de depuración de Chromium
 * (--remote-debugging-port). Los fusibles impiden inyectarle código, así que es la forma de probar el
 * ejecutable real. Lo usan scripts/package-e2e.mjs y scripts/perf-e2e.mjs.
 */
import { spawn } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'

export const wait = (ms) => new Promise((r) => setTimeout(r, ms))
export const exe = (p) => (p.endsWith('.app') ? path.join(p, 'Contents', 'MacOS', 'ZHASKA') : p)

const freePort = () =>
  new Promise((res) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => res(port))
    })
  })

export async function until(fn, ms, step = 500) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    // Mientras la página navega o se recarga, evaluar puede fallar: se reintenta
    const v = await Promise.resolve()
      .then(fn)
      .catch(() => null)
    if (v) return v
    await wait(step)
  }
  return null
}

/** @param p ejecutable (.app en macOS) · @param env variables (ZHASKA_USER_DATA, ZHASKA_PROJECTS_DIR…) */
export async function launch(p, env, { settle = 1500 } = {}) {
  const port = await freePort()
  const spawnedAt = Date.now()
  const child = spawn(exe(p), [`--remote-debugging-port=${port}`], { env: { ...process.env, ...env, ELECTRON_ENABLE_LOGGING: '' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', (d) => (log += d))
  child.stderr.on('data', (d) => (log += d))
  const exited = new Promise((r) => child.on('exit', (code) => r(code)))
  let target = null
  for (let i = 0; i < 600 && !target; i++) {
    await wait(20)
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      target = list.find((t) => t.type === 'page' && t.url.startsWith('app://zhaska/'))
    } catch {
      /* todavía arrancando */
    }
  }
  if (!target) throw new Error(`La app no abrió su ventana:\n${log.slice(-1500)}`)
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r, j) => {
    ws.onopen = r
    ws.onerror = j
  })
  let id = 0
  const pending = new Map()
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data)
    if (d.id && pending.has(d.id)) {
      pending.get(d.id)(d)
      pending.delete(d.id)
    }
  }
  const send = (method, params = {}) =>
    new Promise((r) => {
      const i = ++id
      pending.set(i, r)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  const js = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text)
    return r.result?.result?.value
  }
  const invoke = (channel, req) => js(`window.zhaska.invoke(${JSON.stringify(channel)}, ${JSON.stringify(req)})`)
  const quit = async () => {
    if (process.env.ZHASKA_E2E_LOG) console.log(`--- registro de la app ---\n${log.slice(-6000)}\n---`)
    // Browser.close cierra la app sin responder: no se espera la respuesta
    await Promise.race([send('Browser.close').catch(() => {}), wait(2000)])
    ws.close()
    const code = await Promise.race([exited, wait(15_000).then(() => 'timeout')])
    if (code === 'timeout') {
      child.kill()
      await exited
    }
  }
  if (settle) await wait(settle)
  return { js, invoke, send, quit, spawnedAt, log: () => log }
}
