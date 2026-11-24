import { create } from 'zustand'
import type { AgentEvent } from '@shared/agent/events'
import { activityReducer, initialActivity, type ActivityState } from '@renderer/features/activity/reducer'
import { SCRIPT_AFTER_ALLOW, SCRIPT_AFTER_DENY, SCRIPT_UNTIL_APPROVAL } from '@renderer/demo/activityScript'

type Timed = (typeof SCRIPT_UNTIL_APPROVAL)[number]

interface ActivityStore {
  state: ActivityState
  /** Eventos aplicados, en orden (para el «Registro completo») */
  events: AgentEvent[]
  /** Tarea real del agente que muestra el panel (null = demostración o vacío) */
  realTaskId: string | null
  dispatchReal: (taskId: string, e: AgentEvent) => void
  /** Reconstruye el panel con los eventos guardados de una tarea */
  loadTask: (taskId: string) => Promise<void>
  loadLatest: (conversationId: string) => Promise<void>
  pause: () => void
  resume: () => void
  /** true mientras la demostración se reproduce con tiempos reales. */
  replaying: boolean
  dispatch: (e: AgentEvent) => void
  /** Carga instantáneamente el estado "esperando aprobación" (vista inicial de la demo). */
  loadSnapshot: () => void
  replay: () => void
  resolveApproval: (decision: 'allow_once' | 'allow_always' | 'deny') => void
  stop: () => void
  /** Vacía el panel (al cambiar de proyecto). */
  reset: () => void
}

let timers: number[] = []
const clearTimers = () => {
  timers.forEach((t) => window.clearTimeout(t))
  timers = []
}

export const useActivity = create<ActivityStore>((set, get) => {
  const play = (script: Timed[], speed = 1) => {
    set({ replaying: true })
    script.forEach(({ at, ev }, i) => {
      timers.push(
        window.setTimeout(() => {
          get().dispatch({ ...ev, ts: Date.now() } as AgentEvent)
          if (i === script.length - 1) set({ replaying: false })
        }, at / speed),
      )
    })
  }

  return {
    state: initialActivity,
    events: [],
    replaying: false,
    realTaskId: null,
    dispatch: (e) => set({ state: activityReducer(get().state, e), events: e.type === 'task.started' ? [e] : [...get().events, e] }),
    loadTask: async (taskId) => {
      const { api } = await import('@renderer/lib/api')
      const t = await api('activity.task', { taskId }).catch(() => null)
      if (!t) return
      clearTimers()
      let s = initialActivity
      for (const ev of t.events as AgentEvent[]) s = activityReducer(s, ev)
      set({ realTaskId: t.taskId, replaying: false, state: s, events: t.events as AgentEvent[] })
    },
    loadLatest: async (conversationId) => {
      const { api } = await import('@renderer/lib/api')
      const cur = get()
      if (cur.state.status === 'running' && cur.realTaskId) {
        const live = await api('agent.active').catch(() => [])
        if (live.some((a) => a.taskId === cur.realTaskId && a.conversationId === conversationId)) return
      }
      const t = await api('activity.latest', { conversationId }).catch(() => null)
      if (!t) {
        clearTimers()
        set({ realTaskId: null, replaying: false, state: initialActivity, events: [] })
        return
      }
      await get().loadTask(t.taskId)
    },
    pause: () => {
      const real = get().realTaskId
      if (real) void import('@renderer/lib/api').then(({ api }) => api('agent.pause', { taskId: real }).catch(() => {}))
    },
    resume: () => {
      const real = get().realTaskId
      if (real) void import('@renderer/lib/api').then(({ api }) => api('agent.resume', { taskId: real }).catch(() => {}))
    },
    dispatchReal: (taskId, e) => {
      if (e.type === 'task.started') {
        clearTimers()
        set({ realTaskId: taskId, replaying: false, state: activityReducer(initialActivity, e), events: [e] })
      } else if (taskId === get().realTaskId) set({ state: activityReducer(get().state, e), events: [...get().events, e] })
    },
    loadSnapshot: () => {
      clearTimers()
      const base = Date.now() - (SCRIPT_UNTIL_APPROVAL.at(-1)?.at ?? 0) - 86_000
      let s = initialActivity
      const evs: AgentEvent[] = []
      for (const { at, ev } of SCRIPT_UNTIL_APPROVAL) {
        const full = { ...ev, ts: base + at } as AgentEvent
        evs.push(full)
        s = activityReducer(s, full)
      }
      set({ state: s, replaying: false, events: evs })
    },
    replay: () => {
      clearTimers()
      set({ state: initialActivity, events: [] })
      play(SCRIPT_UNTIL_APPROVAL, 1.6)
    },
    resolveApproval: (decision) => {
      const a = get().state.approval
      if (!a) return
      const real = get().realTaskId
      if (real) {
        void import('@renderer/lib/api').then(({ api }) => api('agent.approve', { taskId: real, requestId: a.requestId, decision }).catch(() => {}))
        return
      }
      get().dispatch({ type: 'approval.resolved', requestId: a.requestId, decision, ts: Date.now() })
      play(decision === 'deny' ? SCRIPT_AFTER_DENY : SCRIPT_AFTER_ALLOW)
    },
    stop: () => {
      const real = get().realTaskId
      if (real && get().state.status === 'running') {
        void import('@renderer/lib/api').then(({ api }) => api('agent.cancel', { taskId: real }).catch(() => {}))
        return
      }
      clearTimers()
      set({ replaying: false })
      get().dispatch({ type: 'task.cancelled', ts: Date.now() })
    },
    reset: () => {
      clearTimers()
      set({ state: initialActivity, replaying: false, realTaskId: null, events: [] })
    },
  }
})
