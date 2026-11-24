import { TOOL_PHASE, type AgentEvent, type ModelState, type Phase, type PlanItem, type Risk, type StepStatus, type ToolName } from '@shared/agent/events'

export interface StepView {
  id: string
  tool: ToolName
  phase: Phase
  title: string
  target?: string
  planItemId?: string
  status: StepStatus
  startedAt: number
  endedAt?: number
  output: string[]
  error?: string
  summary?: string
  diff?: { additions: number; deletions: number }
}

export interface ApprovalView {
  requestId: string
  stepId: string
  tool: ToolName
  command: string
  detail: string
  risk: Risk
  /** false: la acción pregunta siempre; no se ofrece «Siempre aquí» */
  canAlways: boolean
}

export interface ActivityState {
  taskId?: string
  model?: string
  status: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled'
  startedAt?: number
  endedAt?: number
  plan: PlanItem[]
  steps: StepView[]
  approval?: ApprovalView
  modelState: ModelState
  modelStateSince?: number
  tokensPerSec?: number
  tokens: number
  contextUsed: number
  summary?: string
  paused: boolean
  /** Número de eventos aplicados */
  seq: number
}

export const initialActivity: ActivityState = {
  status: 'idle',
  plan: [],
  steps: [],
  modelState: 'idle',
  tokens: 0,
  contextUsed: 0,
  paused: false,
  seq: 0,
}

const patchStep = (s: ActivityState, id: string, p: Partial<StepView>): StepView[] =>
  s.steps.map((st) => (st.id === id ? { ...st, ...p } : st))

/** Reducer puro: mismo código para la demo y para los eventos reales del agente. */
export function activityReducer(s: ActivityState, e: AgentEvent): ActivityState {
  const next = { ...s, seq: s.seq + 1 }
  switch (e.type) {
    case 'task.started':
      return { ...initialActivity, seq: next.seq, taskId: e.taskId, model: e.model, status: 'running', startedAt: e.ts }
    case 'plan.updated':
      return { ...next, plan: e.items }
    case 'step.started':
      return {
        ...next,
        steps: [
          ...s.steps,
          { id: e.stepId, tool: e.tool, phase: TOOL_PHASE[e.tool], title: e.title, target: e.target, planItemId: e.planItemId, status: 'running', startedAt: e.ts, output: [] },
        ],
      }
    case 'step.output':
      return { ...next, steps: s.steps.map((st) => (st.id === e.stepId ? { ...st, output: [...st.output, e.chunk] } : st)) }
    case 'step.completed':
      return { ...next, steps: patchStep(s, e.stepId, { status: 'completed', endedAt: e.ts, summary: e.summary, diff: e.diff }) }
    case 'step.failed':
      return { ...next, steps: patchStep(s, e.stepId, { status: 'failed', endedAt: e.ts, error: e.error }) }
    case 'step.cancelled':
      return { ...next, steps: patchStep(s, e.stepId, { status: 'cancelled', endedAt: e.ts }) }
    case 'approval.requested':
      return { ...next, approval: { requestId: e.requestId, stepId: e.stepId, tool: e.tool, command: e.command, detail: e.detail, risk: e.risk, canAlways: e.canAlways !== false } }
    case 'approval.resolved':
      return { ...next, approval: s.approval?.requestId === e.requestId ? undefined : s.approval }
    case 'model.state':
      return { ...next, modelState: e.state, modelStateSince: e.ts, tokensPerSec: e.tokensPerSec ?? s.tokensPerSec }
    case 'metrics':
      return { ...next, tokens: e.tokens, contextUsed: e.contextUsed }
    case 'task.completed':
      return { ...next, status: 'completed', endedAt: e.ts, summary: e.summary, modelState: 'idle' }
    case 'task.failed':
      return { ...next, status: 'failed', endedAt: e.ts, summary: e.error, modelState: 'idle' }
    case 'task.paused':
      return { ...next, paused: true, modelState: 'paused' }
    case 'task.resumed':
      return { ...next, paused: false, modelState: 'generating' }
    case 'task.cancelled':
      return {
        ...next,
        status: 'cancelled',
        endedAt: e.ts,
        modelState: 'idle',
        paused: false,
        summary: e.reason ?? s.summary,
        approval: undefined,
        steps: s.steps.map((st) => (st.status === 'running' ? { ...st, status: 'cancelled', endedAt: e.ts } : st)),
      }
  }
}

export interface PhaseRow {
  key: string
  kind: 'step' | 'pending'
  step?: StepView
  item?: PlanItem
}

export const PHASES: { id: Phase; label: string }[] = [
  { id: 'analysis', label: 'Análisis' },
  { id: 'planning', label: 'Planificación' },
  { id: 'execution', label: 'Ejecución' },
  { id: 'verification', label: 'Verificación' },
]

/** Agrupa pasos reales y elementos del plan aún no iniciados por fase. */
export function groupByPhase(s: ActivityState) {
  const startedPlanIds = new Set(s.steps.map((st) => st.planItemId).filter(Boolean))
  return PHASES.map(({ id, label }) => {
    const rows: PhaseRow[] = s.steps.filter((st) => st.phase === id).map((st) => ({ key: st.id, kind: 'step', step: st }))
    if (s.status === 'running') {
      for (const item of s.plan) {
        if (item.tool && TOOL_PHASE[item.tool] === id && !startedPlanIds.has(item.id)) rows.push({ key: item.id, kind: 'pending', item })
      }
    }
    const steps = rows.filter((r) => r.step)
    const done = steps.filter((r) => r.step!.status === 'completed').length
    const active = rows.some((r) => r.step?.status === 'running')
    const failed = steps.some((r) => r.step!.status === 'failed')
    const first = steps[0]?.step?.startedAt
    const last = steps.reduce((m, r) => Math.max(m, r.step!.endedAt ?? 0), 0)
    return { id, label, rows, done, total: rows.length, active, failed, durationMs: first && last ? last - first : undefined }
  })
}
