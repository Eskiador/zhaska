import { utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'node:path'
import type { HostEvent, HostRequest } from '@shared/agent/host'

/**
 * Puente con el Agent Host (utilityProcess). Se arranca con la primera petición (chat, agente o banco de
 * pruebas; Fase 11: ~90 MB menos y arranque más rápido mientras solo exploras o editas). Si el proceso termina
 * inesperadamente se avisa a los suscriptores (las tareas en curso se marcan como fallidas) y la siguiente
 * petición lo vuelve a arrancar.
 */
export class AgentHostBridge {
  private proc: UtilityProcess | null = null
  private queue: HostRequest[] = []
  private ready = false
  private quitting = false
  private listeners = new Set<(e: HostEvent) => void>()
  private exitListeners = new Set<() => void>()

  start() {
    this.ready = false
    const proc = utilityProcess.fork(join(__dirname, 'agent.js'), [], { serviceName: 'ZHASKA Agent Host', stdio: 'pipe' })
    this.proc = proc
    proc.stdout?.on('data', (b: Buffer) => console.log(`[agent] ${b.toString().trimEnd()}`))
    proc.stderr?.on('data', (b: Buffer) => console.error(`[agent] ${b.toString().trimEnd()}`))
    proc.on('message', (e: HostEvent) => {
      if (e.type === 'ready') {
        this.ready = true
        this.queue.splice(0).forEach((r) => proc.postMessage(r))
        return
      }
      this.listeners.forEach((l) => l(e))
    })
    proc.on('exit', (code) => {
      if (this.proc === proc) this.proc = null
      this.ready = false
      this.exitListeners.forEach((l) => l())
      if (!this.quitting) {
        console.warn(`[agent] el Agent Host terminó (código ${code})`)
        // Si quedaban peticiones en cola, se vuelve a arrancar para atenderlas
        if (this.queue.length) setTimeout(() => this.start(), 500)
      }
    })
  }

  get running() {
    return !!this.proc
  }

  send(req: HostRequest) {
    if (this.proc && this.ready) return this.proc.postMessage(req)
    this.queue.push(req)
    if (!this.proc && !this.quitting) this.start()
  }

  onEvent(l: (e: HostEvent) => void) {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  onExit(l: () => void) {
    this.exitListeners.add(l)
    return () => this.exitListeners.delete(l)
  }

  dispose() {
    this.quitting = true
    this.proc?.kill()
  }
}
