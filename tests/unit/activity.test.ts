import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '../../src/shared/agent/events'
import { activityReducer, initialActivity } from '../../src/renderer/src/features/activity/reducer'
import { groupSteps, taskStats } from '../../src/renderer/src/features/activity/groups'
import { migrate, openDatabase } from '../../src/main/db/database'
import { AgentRepo, ConversationsRepo, ProjectsRepo } from '../../src/main/db/repos'

let t = 1000
const ev = (e: Record<string, unknown>) => ({ ts: (t += 100), ...e }) as AgentEvent
const reduce = (events: AgentEvent[]) => events.reduce(activityReducer, initialActivity)

const TASK: AgentEvent[] = [
  ev({ type: 'task.started', taskId: 't', model: 'gemma4:12b-it-qat' }),
  ev({ type: 'step.started', stepId: 'a', tool: 'get_project_structure', title: 'Estructura' }),
  ev({ type: 'step.completed', stepId: 'a', summary: '12 entradas' }),
  ev({ type: 'step.started', stepId: 'b', tool: 'read_file', title: 'Leer', target: 'src/a.ts' }),
  ev({ type: 'step.completed', stepId: 'b' }),
  ev({ type: 'step.started', stepId: 'c', tool: 'read_file', title: 'Leer', target: 'src/b.ts' }),
  ev({ type: 'step.completed', stepId: 'c' }),
  ev({ type: 'step.started', stepId: 'd', tool: 'edit_file', title: 'Editar', target: 'src/a.ts' }),
  ev({ type: 'step.completed', stepId: 'd', diff: { additions: 3, deletions: 1 } }),
  ev({ type: 'step.started', stepId: 'e', tool: 'inspect_errors', title: 'Comprobar', target: undefined }),
  ev({ type: 'step.output', stepId: 'e', chunk: "src/a.ts(3,5): error TS2304: Cannot find name 'x'." }),
  ev({ type: 'step.failed', stepId: 'e', error: '1 errores' }),
  ev({ type: 'step.started', stepId: 'f', tool: 'edit_file', title: 'Editar', target: 'src/a.ts' }),
  ev({ type: 'step.completed', stepId: 'f', diff: { additions: 1, deletions: 1 } }),
  ev({ type: 'task.paused' }),
  ev({ type: 'task.resumed' }),
  ev({ type: 'task.completed', summary: 'Tarea completada · 1 archivo modificado' }),
]

describe('panel de actividad', () => {
  it('agrupa pasos como en la referencia y detecta la corrección de errores', () => {
    const groups = groupSteps(reduce(TASK))
    expect(groups.map((g) => [g.kind, g.label, g.steps.length])).toEqual([
      ['analyze', 'Proyecto analizado', 1],
      ['read', 'Código leído', 2],
      ['edit', 'Archivos modificados', 1],
      ['check', 'Errores detectados', 1],
      ['fix', 'Errores corregidos', 1],
    ])
    expect(groups[1]!.files).toEqual(['a.ts', 'b.ts'])
  })

  it('calcula las estadísticas de la tarea actual', () => {
    expect(taskStats(reduce(TASK))).toEqual({ read: 2, changed: 1, additions: 4, deletions: 2, actions: 6 })
  })

  it('refleja pausa y reanudación', () => {
    const paused = reduce(TASK.slice(0, 15))
    expect(paused).toMatchObject({ paused: true, modelState: 'paused', status: 'running' })
    expect(reduce(TASK)).toMatchObject({ paused: false, status: 'completed' })
  })

  it('reconstruye exactamente el mismo estado a partir de los eventos guardados', () => {
    const live = reduce(TASK)
    const rebuilt = reduce(JSON.parse(JSON.stringify(TASK)) as AgentEvent[])
    expect(rebuilt).toEqual(live)
  })
})

describe('agrupación por resultado', () => {
  it('no mezcla en una tarjeta un paso fallido con uno denegado', () => {
    const groups = groupSteps(
      reduce([
        ev({ type: 'task.started', taskId: 't', model: 'm' }),
        ev({ type: 'step.started', stepId: 'x', tool: 'create_file', title: 'Crear', target: 'a.txt' }),
        ev({ type: 'step.failed', stepId: 'x', error: 'ruta no válida' }),
        ev({ type: 'step.started', stepId: 'y', tool: 'create_file', title: 'Crear', target: 'a.txt' }),
        ev({ type: 'step.cancelled', stepId: 'y' }),
      ]),
    )
    expect(groups.map((g) => g.status)).toEqual(['failed', 'cancelled'])
  })
})

describe('registro de actividad en SQLite', () => {
  it('guarda los eventos en orden y deja constancia de las tareas interrumpidas', () => {
    const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'zh-act-')), 'z.db'))
    migrate(db)
    const p = new ProjectsRepo(db, 'linux').touchByRoot('/p', 'p')
    const c = new ConversationsRepo(db).create(p.id)
    const repo = new AgentRepo(db)
    repo.startTask('t1', c.id, p.id, 'm')
    TASK.slice(0, 5).forEach((e) => repo.addEvent('t1', e as never))
    expect(repo.events('t1')).toEqual(JSON.parse(JSON.stringify(TASK.slice(0, 5))))
    expect(repo.latestTask(c.id)).toBe('t1')
    // La app se cierra con la tarea en curso → al volver a abrir queda cancelada con motivo
    repo.closeOrphans()
    const evs = repo.events('t1') as { type: string; reason?: string }[]
    expect(evs.at(-1)).toMatchObject({ type: 'task.cancelled', reason: expect.stringContaining('se cerró') })
    expect(repo.task('t1')?.status).toBe('cancelled')
    const rebuilt = reduce(evs as AgentEvent[])
    expect(rebuilt.status).toBe('cancelled')
    expect(rebuilt.summary).toMatch(/se cerró/)
  })
})
