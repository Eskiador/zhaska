import { create } from 'zustand'
import type { TerminalInfo } from '@shared/ipc/contract'
import { api, errorMessage, hasBackend, onEvent } from '@renderer/lib/api'
import { toast } from './ui'

/** Salida reciente por sesión: para repintar una terminal al volver a montarla. */
const MAX_SCROLLBACK = 200_000
const scrollback = new Map<string, string>()
const listeners = new Map<string, (data: string) => void>()

export const terminalIO = {
  attach(id: string, write: (data: string) => void) {
    listeners.set(id, write)
    const prev = scrollback.get(id)
    if (prev) write(prev)
    return () => listeners.delete(id)
  },
}

interface TerminalStore {
  sessions: (TerminalInfo & { exitCode?: number })[]
  /** 'agent' | 'problems' | id de sesión | 'new' (pestaña «Terminal» aún sin abrir) */
  active: string
  init: () => void
  load: (projectId: string) => Promise<void>
  create: (projectId: string, cols?: number, rows?: number) => Promise<string | null>
  kill: (id: string) => Promise<void>
  setActive: (tab: string) => void
  reset: () => void
}

let initialized = false

export const useTerminals = create<TerminalStore>((set, get) => ({
  sessions: [],
  active: 'new',
  init: () => {
    if (initialized || !hasBackend) return
    initialized = true
    onEvent('terminal.data', ({ id, data }) => {
      const prev = scrollback.get(id) ?? ''
      const next = prev + data
      scrollback.set(id, next.length > MAX_SCROLLBACK ? next.slice(next.length - MAX_SCROLLBACK) : next)
      listeners.get(id)?.(data)
    })
    onEvent('terminal.exit', ({ id, exitCode }) => {
      const msg = `\r\n\x1b[38;2;133;133;143m[proceso terminado · código ${exitCode}]\x1b[0m\r\n`
      scrollback.set(id, (scrollback.get(id) ?? '') + msg)
      listeners.get(id)?.(msg)
      set({ sessions: get().sessions.map((s) => (s.id === id ? { ...s, alive: false, exitCode } : s)) })
    })
  },
  load: async (projectId) => {
    if (!hasBackend) return
    const sessions = await api('terminal.list', { projectId }).catch(() => [])
    set({ sessions, active: sessions[0]?.id ?? 'new' })
  },
  create: async (projectId, cols = 100, rows = 24) => {
    try {
      const s = await api('terminal.create', { projectId, cols, rows })
      set({ sessions: [...get().sessions, s], active: s.id })
      return s.id
    } catch (e) {
      toast({ tone: 'error', title: 'No se pudo abrir la terminal', description: errorMessage(e) })
      return null
    }
  },
  kill: async (id) => {
    await api('terminal.kill', { id }).catch(() => {})
    scrollback.delete(id)
    const rest = get().sessions.filter((s) => s.id !== id)
    set({ sessions: rest, active: get().active === id ? (rest[rest.length - 1]?.id ?? 'new') : get().active })
  },
  setActive: (active) => set({ active }),
  reset: () => {
    scrollback.clear()
    set({ sessions: [], active: 'new' })
  },
}))
