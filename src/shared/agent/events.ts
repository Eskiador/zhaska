/**
 * Eventos del agente: fuente única del panel de actividad (ARCHITECTURE §6.6).
 * En la Fase 2 los produce una repetición de demostración; desde la Fase 5, el AgentLoop real.
 */

export type Phase = 'analysis' | 'planning' | 'execution' | 'verification'
export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export type ToolName =
  | 'get_project_structure'
  | 'list_files'
  | 'read_file'
  | 'search_code'
  | 'read_project_config'
  | 'read_attachment'
  | 'update_plan'
  | 'create_file'
  | 'edit_file'
  | 'write_file'
  | 'delete_file'
  | 'execute_command'
  | 'install_dependencies'
  | 'run_tests'
  | 'inspect_errors'

/** La fase se deriva de la herramienta real, nunca de una animación. */
export const TOOL_PHASE: Record<ToolName, Phase> = {
  get_project_structure: 'analysis',
  list_files: 'analysis',
  read_file: 'analysis',
  search_code: 'analysis',
  read_project_config: 'analysis',
  read_attachment: 'analysis',
  update_plan: 'planning',
  create_file: 'execution',
  edit_file: 'execution',
  write_file: 'execution',
  delete_file: 'execution',
  execute_command: 'execution',
  install_dependencies: 'execution',
  run_tests: 'verification',
  inspect_errors: 'verification',
}

export type Risk = 'read' | 'write' | 'destructive' | 'execute'

export interface PlanItem {
  id: string
  title: string
  tool?: ToolName
  target?: string
}

export type ModelState = 'idle' | 'prompt' | 'thinking' | 'generating' | 'waiting_approval' | 'paused'

export type AgentEvent =
  | { type: 'task.started'; taskId: string; model: string; ts: number }
  | { type: 'plan.updated'; items: PlanItem[]; ts: number }
  | { type: 'step.started'; stepId: string; tool: ToolName; title: string; target?: string; planItemId?: string; ts: number }
  | { type: 'step.output'; stepId: string; chunk: string; ts: number }
  | { type: 'step.completed'; stepId: string; summary?: string; diff?: { additions: number; deletions: number }; ts: number }
  | { type: 'step.failed'; stepId: string; error: string; ts: number }
  | { type: 'step.cancelled'; stepId: string; ts: number }
  /** canAlways=false: acción que pregunta siempre (peligrosa, protegida, fuera del proyecto, borrado): sin «Siempre aquí» */
  | { type: 'approval.requested'; requestId: string; stepId: string; tool: ToolName; command: string; detail: string; risk: Risk; canAlways?: boolean; ts: number }
  | { type: 'approval.resolved'; requestId: string; decision: 'allow_once' | 'allow_always' | 'deny'; ts: number }
  | { type: 'model.state'; state: ModelState; tokensPerSec?: number; ts: number }
  | { type: 'metrics'; tokens: number; contextUsed: number; ts: number }
  | { type: 'task.completed'; summary: string; ts: number }
  | { type: 'task.failed'; error: string; ts: number }
  | { type: 'task.cancelled'; ts: number; reason?: string }
  | { type: 'task.paused'; ts: number }
  | { type: 'task.resumed'; ts: number }
