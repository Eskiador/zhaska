import { useEffect, useState } from 'react'
import { Check, GitCompare, GitPullRequestDraft, Undo2 } from 'lucide-react'
import type { FileChange as FileChangeRow } from '@shared/ipc/contract'
import { Button } from '@renderer/components/ui/Button'
import { confirm } from '@renderer/components/ui/confirm'
import { cn } from '@renderer/lib/cn'
import { api, ApiError, errorMessage } from '@renderer/lib/api'
import { useLayout } from '@renderer/stores/layout'
import { toast } from '@renderer/stores/ui'
import { useWorkspace } from '@renderer/stores/workspace'
import type { FileChange } from '@renderer/demo/conversations'

/**
 * Cambios de una tarea del agente. En tareas reales: aceptar (conservar) o rechazar (restaurar el original
 * guardado, con aviso si el archivo cambió después). En la demostración, solo vista.
 */
export function ChangesCard({ changes, taskId }: { changes: FileChange[]; taskId?: string }) {
  const [rows, setRows] = useState<FileChangeRow[] | null>(null)
  const [busy, setBusy] = useState(false)
  // Se vuelve a leer cuando cambian los pendientes del proyecto (p. ej., al aceptar o rechazar desde el editor)
  const pendingKey = useWorkspace((s) => Object.values(s.pending).map((c) => `${c.taskId}:${c.rel}`).join('|'))

  useEffect(() => {
    if (taskId) void api('changes.list', { taskId }).then(setRows).catch(() => setRows(null))
  }, [taskId, pendingKey])

  const status = (path: string) => rows?.find((r) => r.rel === path)?.status ?? 'pending'
  const pending = taskId ? (rows ?? []).filter((r) => r.status === 'pending').length : changes.length
  const add = changes.reduce((a, c) => a + c.additions, 0)
  const del = changes.reduce((a, c) => a + c.deletions, 0)

  const openDiff = async (path: string) => {
    useLayout.getState().show('workbench')
    if (!taskId) {
      if (useWorkspace.getState().files[path]?.original !== undefined) void useWorkspace.getState().openFile(path, { diff: true })
      return
    }
    try {
      const c = await api('changes.contents', { taskId, rel: path })
      if (c.after === null) return toast({ tone: 'info', title: `${path} fue eliminado por el agente`, description: 'Recházalo para restaurarlo.' })
      await useWorkspace.getState().openAgentDiff(path, c.before)
      await useWorkspace.getState().loadPending()
    } catch (e) {
      toast({ tone: 'error', title: 'No se pudo abrir el diff', description: errorMessage(e) })
    }
  }

  const act = async (kind: 'accept' | 'reject', rel?: string) => {
    if (!taskId) return toast({ tone: 'info', title: 'Proyecto de demostración', description: 'Estos cambios son simulados.' })
    if (kind === 'reject' && !(await confirm({ title: rel ? `Rechazar cambios en ${rel}` : 'Rechazar todos los cambios', description: 'Se restaurará el contenido anterior a la tarea (los archivos creados por el agente irán a la papelera).', confirmLabel: 'Rechazar y restaurar', danger: true }))) return
    setBusy(true)
    try {
      setRows(kind === 'accept' ? await api('changes.accept', { taskId, rel }) : await api('changes.reject', { taskId, rel }))
      void useWorkspace.getState().loadPending()
      toast({ tone: 'success', title: kind === 'accept' ? 'Cambios aceptados' : 'Cambios rechazados y archivos restaurados' })
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CONFLICT' && (await confirm({ title: 'El archivo cambió después', description: `${e.message}`, confirmLabel: 'Restaurar de todas formas', danger: true }))) {
        setRows(await api('changes.reject', { taskId, rel, force: true }).catch(() => rows ?? []))
      } else if (!(e instanceof ApiError && e.code === 'CONFLICT')) toast({ tone: 'error', title: 'No se pudo completar', description: errorMessage(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-3 overflow-hidden rounded-[10px] border border-line bg-bg-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-line-subtle px-3 py-2.5">
        <GitPullRequestDraft className="size-4 shrink-0 text-agent" />
        <span className="whitespace-nowrap font-semibold">{changes.length} archivo{changes.length === 1 ? '' : 's'} cambiado{changes.length === 1 ? '' : 's'}</span>
        <span className="whitespace-nowrap font-mono text-small">
          <span className="text-ok">+{add}</span> <span className="text-err">−{del}</span>
        </span>
        <div className="ml-auto flex shrink-0 gap-1.5">
          <Button size="sm" variant="ghost" icon={<Undo2 />} disabled={busy || pending === 0} onClick={() => void act('reject')}>
            Rechazar todo
          </Button>
          <Button size="sm" variant="primary" icon={<Check />} disabled={busy || pending === 0} onClick={() => void act('accept')}>
            Aceptar todo
          </Button>
        </div>
      </div>
      {changes.map((c) => {
        const st = status(c.path)
        return (
          <div key={c.path} className="group flex items-center gap-2 px-3 py-1.5 text-body hover:bg-bg-3">
            <span className={cn('rounded-sm px-1 font-mono text-micro', c.kind === 'create' ? 'bg-ok-soft text-ok' : c.kind === 'delete' ? 'bg-err-soft text-err' : 'bg-warn-soft text-git-modified')}>
              {c.kind === 'create' ? 'A' : c.kind === 'delete' ? 'D' : 'M'}
            </span>
            <button type="button" onClick={() => void openDiff(c.path)} className={cn('truncate text-left font-mono text-small hover:underline', st === 'rejected' ? 'text-fg-3 line-through' : 'text-fg-1')}>
              {c.path}
            </button>
            {st !== 'pending' && <span className={cn('text-tiny', st === 'accepted' ? 'text-ok' : 'text-fg-3')}>{st === 'accepted' ? 'aceptado' : 'restaurado'}</span>}
            <span className="ml-auto shrink-0 font-mono text-small">
              {c.additions > 0 && <span className="text-ok">+{c.additions}</span>} {c.deletions > 0 && <span className="text-err">−{c.deletions}</span>}
            </span>
            {taskId && st === 'pending' && (
              <span className="hidden gap-1 group-hover:flex">
                <button type="button" title="Ver diff" onClick={() => void openDiff(c.path)} className="grid size-6 place-items-center rounded-sm text-fg-3 hover:bg-bg-4 hover:text-fg-1">
                  <GitCompare className="size-3.5" />
                </button>
                <button type="button" title="Rechazar este archivo" onClick={() => void act('reject', c.path)} className="grid size-6 place-items-center rounded-sm text-fg-3 hover:bg-bg-4 hover:text-err">
                  <Undo2 className="size-3.5" />
                </button>
                <button type="button" title="Aceptar este archivo" onClick={() => void act('accept', c.path)} className="grid size-6 place-items-center rounded-sm text-fg-3 hover:bg-bg-4 hover:text-ok">
                  <Check className="size-3.5" />
                </button>
              </span>
            )}
          </div>
        )
      })}
      <div className="border-t border-line-subtle px-3 py-1.5 text-tiny text-fg-3">{taskId ? 'Los cambios ya están aplicados en el disco. Rechazar restaura la copia guardada antes de la tarea.' : 'Demostración: cambios simulados.'}</div>
    </div>
  )
}
