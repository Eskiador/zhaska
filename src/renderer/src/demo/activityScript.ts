/**
 * ⚠️ DATOS SIMULADOS (Fase 2).
 * Guion de eventos `AgentEvent` que reproduce una tarea típica. Usa exactamente el mismo tipo y el mismo
 * reducer que consumirá los eventos reales del AgentLoop en las Fases 5–6: solo cambia la fuente.
 */
import type { AgentEvent } from '@shared/agent/events'

type Timed = { at: number; ev: DistributiveOmit<AgentEvent, 'ts'> }
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never

export const DEMO_TASK_ID = 'demo-task-1'

/** Parte 1: hasta la petición de aprobación de `npm install`. */
export const SCRIPT_UNTIL_APPROVAL: Timed[] = [
  { at: 0, ev: { type: 'task.started', taskId: DEMO_TASK_ID, model: 'gemma4:12b-it-qat' } },
  { at: 0, ev: { type: 'model.state', state: 'prompt' } },
  { at: 900, ev: { type: 'model.state', state: 'generating', tokensPerSec: 29.8 } },
  { at: 1400, ev: { type: 'step.started', stepId: 's1', tool: 'get_project_structure', title: 'Estructura del proyecto', target: '.' } },
  { at: 1600, ev: { type: 'step.completed', stepId: 's1', summary: '15 archivos · 6 carpetas' } },
  { at: 1700, ev: { type: 'step.started', stepId: 's2', tool: 'read_project_config', title: 'Leer configuración', target: 'package.json · tsconfig.json' } },
  { at: 1800, ev: { type: 'step.completed', stepId: 's2', summary: 'React 19 · Vite 8 · Vitest' } },
  { at: 1900, ev: { type: 'step.started', stepId: 's3', tool: 'read_file', title: 'Leer archivo', target: 'src/components/Header.tsx' } },
  { at: 2000, ev: { type: 'step.completed', stepId: 's3', summary: '13 líneas' } },
  { at: 2100, ev: { type: 'step.started', stepId: 's4', tool: 'read_attachment', title: 'Analizar adjunto', target: 'ventas_2026.xlsx' } },
  { at: 3500, ev: { type: 'step.completed', stepId: 's4', summary: '2 hojas · 48 filas' } },
  { at: 3600, ev: { type: 'model.state', state: 'thinking' } },
  { at: 9800, ev: { type: 'model.state', state: 'generating', tokensPerSec: 31.4 } },
  { at: 9900, ev: { type: 'step.started', stepId: 's5', tool: 'update_plan', title: 'Plan de trabajo', target: '6 pasos' } },
  {
    at: 10000,
    ev: {
      type: 'plan.updated',
      items: [
        { id: 'p1', title: 'Crear componente del gráfico', tool: 'create_file', target: 'src/components/SalesChart.tsx' },
        { id: 'p2', title: 'Integrar en el dashboard', tool: 'edit_file', target: 'src/components/Dashboard.tsx' },
        { id: 'p3', title: 'Envolver la app', tool: 'edit_file', target: 'src/App.tsx' },
        { id: 'p4', title: 'Instalar dependencias', tool: 'install_dependencies', target: 'npm install recharts@3' },
        { id: 'p5', title: 'Comprobar tipos', tool: 'inspect_errors', target: 'tsc --noEmit' },
        { id: 'p6', title: 'Ejecutar pruebas', tool: 'run_tests', target: 'npm test' },
      ],
    },
  },
  { at: 10050, ev: { type: 'step.completed', stepId: 's5' } },
  { at: 12800, ev: { type: 'step.started', stepId: 's6', tool: 'create_file', title: 'Crear archivo', target: 'src/components/SalesChart.tsx', planItemId: 'p1' } },
  { at: 12900, ev: { type: 'step.completed', stepId: 's6', diff: { additions: 37, deletions: 0 } } },
  { at: 15600, ev: { type: 'step.started', stepId: 's7', tool: 'edit_file', title: 'Editar archivo', target: 'src/components/Dashboard.tsx', planItemId: 'p2' } },
  { at: 15700, ev: { type: 'step.completed', stepId: 's7', diff: { additions: 17, deletions: 6 } } },
  { at: 17200, ev: { type: 'step.started', stepId: 's8', tool: 'edit_file', title: 'Editar archivo', target: 'src/App.tsx', planItemId: 'p3' } },
  { at: 17300, ev: { type: 'step.completed', stepId: 's8', diff: { additions: 8, deletions: 1 } } },
  { at: 17400, ev: { type: 'step.started', stepId: 's9', tool: 'inspect_errors', title: 'Comprobar tipos', target: 'tsc --noEmit' } },
  { at: 17450, ev: { type: 'step.output', stepId: 's9', chunk: '> tsc --noEmit' } },
  { at: 20600, ev: { type: 'step.output', stepId: 's9', chunk: "src/components/SalesChart.tsx(1,82): error TS2307: Cannot find module 'recharts'." } },
  { at: 20700, ev: { type: 'step.failed', stepId: 's9', error: "TS2307 · Cannot find module 'recharts'" } },
  { at: 20800, ev: { type: 'metrics', tokens: 18240, contextUsed: 0.41 } },
  { at: 22100, ev: { type: 'step.started', stepId: 's10', tool: 'install_dependencies', title: 'Instalar dependencias', target: 'npm install recharts@3', planItemId: 'p4' } },
  {
    at: 22150,
    ev: {
      type: 'approval.requested',
      requestId: 'a1',
      stepId: 's10',
      tool: 'install_dependencies',
      command: 'npm install recharts@3',
      detail: 'Instala 1 paquete en tienda-analytics/. Modifica package.json y package-lock.json.',
      risk: 'execute',
    },
  },
  { at: 22150, ev: { type: 'model.state', state: 'waiting_approval' } },
]

/** Parte 2a: el usuario permite el comando. */
export const SCRIPT_AFTER_ALLOW: Timed[] = [
  { at: 0, ev: { type: 'model.state', state: 'generating', tokensPerSec: 31.4 } },
  { at: 100, ev: { type: 'step.output', stepId: 's10', chunk: '> npm install recharts@3' } },
  { at: 1800, ev: { type: 'step.output', stepId: 's10', chunk: 'added 38 packages, and audited 214 packages in 4s' } },
  { at: 1900, ev: { type: 'step.output', stepId: 's10', chunk: 'found 0 vulnerabilities' } },
  { at: 2000, ev: { type: 'step.completed', stepId: 's10', summary: '+38 paquetes', diff: { additions: 1, deletions: 0 } } },
  { at: 2300, ev: { type: 'step.started', stepId: 's11', tool: 'inspect_errors', title: 'Comprobar tipos', target: 'tsc --noEmit', planItemId: 'p5' } },
  { at: 2350, ev: { type: 'step.output', stepId: 's11', chunk: '> tsc --noEmit' } },
  { at: 5300, ev: { type: 'step.completed', stepId: 's11', summary: '0 errores' } },
  { at: 5500, ev: { type: 'step.started', stepId: 's12', tool: 'run_tests', title: 'Ejecutar pruebas', target: 'npm test', planItemId: 'p6' } },
  { at: 5550, ev: { type: 'step.output', stepId: 's12', chunk: '> vitest run' } },
  { at: 7900, ev: { type: 'step.output', stepId: 's12', chunk: ' ✓ src/hooks/useSales.test.ts (4 tests) 12ms' } },
  { at: 8000, ev: { type: 'step.output', stepId: 's12', chunk: ' Test Files  1 passed (1) · Tests  4 passed (4)' } },
  { at: 8100, ev: { type: 'step.completed', stepId: 's12', summary: '4/4 pruebas' } },
  { at: 8200, ev: { type: 'metrics', tokens: 21980, contextUsed: 0.49 } },
  { at: 10400, ev: { type: 'model.state', state: 'idle' } },
  { at: 10400, ev: { type: 'task.completed', summary: 'Dashboard con gráfico de barras creado y verificado.' } },
]

/** Parte 2b: el usuario deniega el comando. */
export const SCRIPT_AFTER_DENY: Timed[] = [
  { at: 0, ev: { type: 'step.cancelled', stepId: 's10' } },
  { at: 200, ev: { type: 'model.state', state: 'generating', tokensPerSec: 30.2 } },
  { at: 2600, ev: { type: 'model.state', state: 'idle' } },
  { at: 2600, ev: { type: 'task.cancelled' } },
]
