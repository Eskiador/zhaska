import { useEffect, useRef, useState } from 'react'
import { DiffEditor, type DiffOnMount } from '@monaco-editor/react'
import { Check, ChevronLeft, ChevronRight, Sparkles, Undo2 } from 'lucide-react'
import { monaco, THEME } from './monaco'
import { languageOf } from './languages'
import { Button } from '@renderer/components/ui/Button'
import { confirm } from '@renderer/components/ui/confirm'
import { api, errorMessage } from '@renderer/lib/api'
import { useSettings } from '@renderer/stores/settings'
import { toast } from '@renderer/stores/ui'
import { useWorkspace } from '@renderer/stores/workspace'

/**
 * Propuestas del agente dentro del editor (referencia: «Cambio 1 de 3 · propuesto por Forja · Rechazar / Aceptar»).
 * Original = copia guardada antes de la tarea; derecha = archivo actual (editable).
 * Rechazar un cambio deshace solo ese fragmento y guarda; cuando no quedan cambios, el archivo queda revisado.
 */
export default function ProposalDiff({ path }: { path: string }) {
  const value = useWorkspace((s) => s.files[path]?.content ?? '')
  const original = useWorkspace((s) => s.files[path]?.original ?? '')
  const pending = useWorkspace((s) => s.pending[path])
  const fontSize = useSettings((s) => s.editorFontSize)
  const diffRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  const [changes, setChanges] = useState<monaco.editor.ILineChange[]>([])
  const [index, setIndex] = useState(0)
  const [accepted, setAccepted] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  const keyOf = (c: monaco.editor.ILineChange) => `${c.modifiedStartLineNumber}:${c.modifiedEndLineNumber}:${c.originalStartLineNumber}:${c.originalEndLineNumber}`
  const open = changes.filter((c) => !accepted.has(keyOf(c)))
  const current = open[Math.min(index, open.length - 1)]

  const reveal = (c?: monaco.editor.ILineChange) => {
    if (!c || !diffRef.current) return
    const line = Math.max(1, c.modifiedEndLineNumber === 0 ? c.modifiedStartLineNumber : c.modifiedStartLineNumber)
    diffRef.current.getModifiedEditor().revealLineInCenter(line)
  }

  useEffect(() => reveal(current), [current?.modifiedStartLineNumber, current?.originalStartLineNumber]) // eslint-disable-line react-hooks/exhaustive-deps

  const onMount: DiffOnMount = (editor) => {
    diffRef.current = editor
    const modified = editor.getModifiedEditor()
    modified.onDidChangeModelContent(() => useWorkspace.getState().updateBuffer(path, modified.getValue()))
    modified.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void useWorkspace.getState().save(path))
    editor.onDidUpdateDiff(() => setChanges(editor.getLineChanges() ?? []))
  }

  const finish = async (status: 'accepted' | 'rejected') => {
    if (!pending) return
    await api('changes.mark', { taskId: pending.taskId, rel: path, status }).catch(() => {})
    await useWorkspace.getState().loadPending()
    toast({ tone: 'success', title: status === 'accepted' ? 'Cambios aceptados' : 'Cambios rechazados', description: path })
  }

  /** Deshace un fragmento: vuelve a poner las líneas originales en el archivo actual. */
  const rejectOne = async (c: monaco.editor.ILineChange) => {
    const ed = diffRef.current
    if (!ed) return
    const orig = ed.getOriginalEditor().getModel()!
    const mod = ed.getModifiedEditor().getModel()!
    const eol = mod.getEOL()
    const origText = c.originalEndLineNumber === 0 ? '' : orig.getValueInRange(new monaco.Range(c.originalStartLineNumber, 1, c.originalEndLineNumber, orig.getLineMaxColumn(c.originalEndLineNumber)))
    let range: monaco.Range
    let text: string
    if (c.modifiedEndLineNumber === 0) {
      // El agente borró líneas: reinsertarlas tras la línea indicada
      const after = c.modifiedStartLineNumber
      range = after === 0 ? new monaco.Range(1, 1, 1, 1) : new monaco.Range(after, mod.getLineMaxColumn(after), after, mod.getLineMaxColumn(after))
      text = after === 0 ? origText + eol : eol + origText
    } else if (c.originalEndLineNumber === 0) {
      // El agente añadió líneas: quitarlas (con su salto de línea)
      const last = c.modifiedEndLineNumber
      range = last < mod.getLineCount() ? new monaco.Range(c.modifiedStartLineNumber, 1, last + 1, 1) : new monaco.Range(Math.max(1, c.modifiedStartLineNumber - 1), c.modifiedStartLineNumber > 1 ? mod.getLineMaxColumn(c.modifiedStartLineNumber - 1) : 1, last, mod.getLineMaxColumn(last))
      text = ''
    } else {
      range = new monaco.Range(c.modifiedStartLineNumber, 1, c.modifiedEndLineNumber, mod.getLineMaxColumn(c.modifiedEndLineNumber))
      text = origText
    }
    mod.pushEditOperations([], [{ range, text }], () => null)
    setBusy(true)
    const saved = await useWorkspace.getState().save(path)
    setBusy(false)
    if (saved && useWorkspace.getState().files[path]?.content === original) await finish('rejected')
  }

  const acceptOne = async (c: monaco.editor.ILineChange) => {
    const next = new Set(accepted).add(keyOf(c))
    setAccepted(next)
    if (changes.every((x) => next.has(keyOf(x)))) await finish('accepted')
  }

  const rejectFile = async () => {
    if (!pending) return
    if (!(await confirm({ title: `Rechazar todos los cambios de ${path.split('/').pop()}`, description: pending.kind === 'create' ? 'El archivo lo creó el agente: irá a la papelera.' : 'Se restaurará el contenido anterior a la tarea.', confirmLabel: 'Rechazar', danger: true }))) return
    try {
      await api('changes.reject', { taskId: pending.taskId, rel: path, force: true })
      await useWorkspace.getState().reloadFromDisk(path)
      await useWorkspace.getState().loadPending()
      if (pending.kind === 'create') useWorkspace.getState().closeTab(path)
      toast({ tone: 'success', title: 'Cambios rechazados', description: path })
    } catch (e) {
      toast({ tone: 'error', title: 'No se pudo rechazar', description: errorMessage(e) })
    }
  }

  return (
    <div className="flex h-full flex-col">
      {pending ? (
        <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-line-subtle bg-bg-1 px-3 py-1.5 text-small">
          <Sparkles className="size-3.5 shrink-0 text-agent" />
          <span className="whitespace-nowrap text-fg-2">{open.length ? `Cambio ${Math.min(index, open.length - 1) + 1} de ${open.length}` : 'Sin cambios por revisar'} · propuesto por ZHASKA</span>
          <button type="button" aria-label="Cambio anterior" disabled={open.length < 2} onClick={() => setIndex((i) => (i - 1 + open.length) % open.length)} className="grid size-6 place-items-center rounded-sm text-fg-3 hover:bg-bg-3 hover:text-fg-1 disabled:opacity-30">
            <ChevronLeft className="size-4" />
          </button>
          <button type="button" aria-label="Cambio siguiente" disabled={open.length < 2} onClick={() => setIndex((i) => (i + 1) % open.length)} className="grid size-6 place-items-center rounded-sm text-fg-3 hover:bg-bg-3 hover:text-fg-1 disabled:opacity-30">
            <ChevronRight className="size-4" />
          </button>
          <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1.5">
            {current && (
              <>
                <Button size="sm" variant="ghost" icon={<Undo2 />} disabled={busy} onClick={() => void rejectOne(current)}>
                  Rechazar
                </Button>
                <Button size="sm" variant="primary" icon={<Check />} disabled={busy} onClick={() => void acceptOne(current)}>
                  Aceptar
                </Button>
              </>
            )}
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void rejectFile()}>
              Rechazar archivo
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void finish('accepted')}>
              Aceptar archivo
            </Button>
          </div>
        </div>
      ) : (
        <div className="shrink-0 border-b border-line-subtle bg-bg-1 px-3 py-1.5 text-small text-fg-3">Cambios ya revisados · original ← → actual</div>
      )}
      <div className="relative min-h-0 flex-1">
        <DiffEditor
          key={`proposal:${path}`}
          theme={THEME}
          language={languageOf(path).id}
          original={original}
          modified={value}
          originalModelPath={`original:///${path}`}
          modifiedModelPath={`file:///${path}`}
          onMount={onMount}
          options={{
            fontFamily: '"Geist Mono Variable", "Cascadia Code", Consolas, monospace',
            fontSize,
            renderSideBySide: false,
            originalEditable: false,
            readOnly: false,
            automaticLayout: true,
            minimap: { enabled: false },
            renderOverviewRuler: true,
            scrollBeyondLastLine: false,
            hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 5 },
          }}
        />
      </div>
    </div>
  )
}
