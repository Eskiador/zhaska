import type { StepStatus, ToolName } from '@shared/agent/events'
import type { ActivityState, StepView } from './reducer'

/**
 * Agrupa los pasos reales en tarjetas como en la referencia de diseño:
 * pasos consecutivos del mismo tipo (leer, explorar, editar…) forman una tarjeta;
 * los comandos, pruebas e instalaciones van siempre solos.
 */
export type GroupKind = 'analyze' | 'explore' | 'read' | 'attach' | 'plan' | 'create' | 'edit' | 'fix' | 'delete' | 'command' | 'install' | 'tests' | 'check'

const KIND: Record<ToolName, GroupKind> = {
  get_project_structure: 'analyze',
  read_project_config: 'analyze',
  list_files: 'explore',
  search_code: 'explore',
  read_file: 'read',
  read_attachment: 'attach',
  update_plan: 'plan',
  create_file: 'create',
  edit_file: 'edit',
  write_file: 'edit',
  delete_file: 'delete',
  execute_command: 'command',
  install_dependencies: 'install',
  run_tests: 'tests',
  inspect_errors: 'check',
}

const MERGEABLE = new Set<GroupKind>(['analyze', 'explore', 'read', 'attach', 'create', 'edit', 'fix'])

/** Etiqueta en curso → completada → con error (referencia: «Leyendo código → Código leído»). */
export const LABELS: Record<GroupKind, { running: string; done: string; failed: string }> = {
  analyze: { running: 'Analizando proyecto', done: 'Proyecto analizado', failed: 'No se pudo analizar el proyecto' },
  explore: { running: 'Explorando archivos', done: 'Archivos explorados', failed: 'Error al explorar' },
  read: { running: 'Leyendo código', done: 'Código leído', failed: 'Error al leer' },
  attach: { running: 'Leyendo adjuntos', done: 'Adjuntos leídos', failed: 'Error al leer el adjunto' },
  plan: { running: 'Planificando', done: 'Plan de trabajo', failed: 'Plan no válido' },
  create: { running: 'Creando archivos', done: 'Archivos creados', failed: 'Error al crear' },
  edit: { running: 'Modificando archivos', done: 'Archivos modificados', failed: 'Error al modificar' },
  fix: { running: 'Corrigiendo errores', done: 'Errores corregidos', failed: 'Error al corregir' },
  delete: { running: 'Eliminando archivo', done: 'Archivo eliminado', failed: 'Error al eliminar' },
  command: { running: 'Ejecutando comando', done: 'Comando ejecutado', failed: 'El comando falló' },
  install: { running: 'Instalando dependencias', done: 'Dependencias instaladas', failed: 'Error al instalar' },
  tests: { running: 'Ejecutando pruebas', done: 'Pruebas superadas', failed: 'Pruebas con fallos' },
  check: { running: 'Comprobando errores', done: 'Sin errores', failed: 'Errores detectados' },
}

export interface StepGroup {
  key: string
  kind: GroupKind
  steps: StepView[]
  status: StepStatus
  label: string
  files: string[]
  additions: number
  deletions: number
  startedAt: number
  endedAt?: number
}

const isCommand = (k: GroupKind) => k === 'command' || k === 'install' || k === 'tests' || k === 'check'

function statusOf(steps: StepView[]): StepStatus {
  if (steps.some((s) => s.status === 'running')) return 'running'
  const last = steps[steps.length - 1]!
  if (last.status === 'failed') return 'failed'
  if (steps.every((s) => s.status === 'cancelled')) return 'cancelled'
  return steps.some((s) => s.status === 'completed') ? 'completed' : last.status
}

export function groupSteps(state: ActivityState): StepGroup[] {
  const groups: StepGroup[] = []
  let sawFailure = false
  for (const st of state.steps) {
    let kind = KIND[st.tool]
    // Editar justo después de unas pruebas o comprobación fallidas = corregir errores
    if (kind === 'edit' && sawFailure) kind = 'fix'
    if ((st.tool === 'inspect_errors' || st.tool === 'run_tests') && st.status === 'failed') sawFailure = true
    if ((st.tool === 'inspect_errors' || st.tool === 'run_tests') && st.status === 'completed') sawFailure = false
    const prev = groups[groups.length - 1]
    const prevLast = prev?.steps[prev.steps.length - 1]
    const sameOutcome = prevLast?.status === 'completed' && (st.status === 'completed' || st.status === 'running')
    if (prev && prev.kind === kind && MERGEABLE.has(kind) && !isCommand(kind) && sameOutcome) prev.steps.push(st)
    else groups.push({ key: st.id, kind, steps: [st], status: 'pending', label: '', files: [], additions: 0, deletions: 0, startedAt: st.startedAt })
  }
  for (const g of groups) {
    g.status = statusOf(g.steps)
    g.label = g.status === 'running' ? LABELS[g.kind].running : g.status === 'failed' ? LABELS[g.kind].failed : LABELS[g.kind].done
    g.files = [...new Set(g.steps.filter((s) => s.target && !isCommand(g.kind) && g.kind !== 'plan').map((s) => s.target!.split('/').pop()!))]
    g.additions = g.steps.reduce((a, s) => a + (s.diff?.additions ?? 0), 0)
    g.deletions = g.steps.reduce((a, s) => a + (s.diff?.deletions ?? 0), 0)
    const ends = g.steps.map((s) => s.endedAt).filter((x): x is number => !!x)
    g.endedAt = g.status === 'running' || !ends.length ? undefined : Math.max(...ends)
  }
  return groups
}

/** Estadísticas de la tarjeta «Tarea actual». */
export function taskStats(state: ActivityState) {
  const read = new Set(state.steps.filter((s) => s.tool === 'read_file' && s.status === 'completed' && s.target).map((s) => s.target))
  const changed = new Set(state.steps.filter((s) => s.diff && s.status === 'completed' && s.target).map((s) => s.target))
  const additions = state.steps.reduce((a, s) => a + (s.diff?.additions ?? 0), 0)
  const deletions = state.steps.reduce((a, s) => a + (s.diff?.deletions ?? 0), 0)
  return { read: read.size, changed: changed.size, additions, deletions, actions: state.steps.length }
}
