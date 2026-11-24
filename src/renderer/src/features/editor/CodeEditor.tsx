import { useEffect, useRef } from 'react'
import Editor, { DiffEditor, type OnMount } from '@monaco-editor/react'
import { monaco, THEME } from './monaco'
import { languageOf } from './languages'
import { useWorkspace } from '@renderer/stores/workspace'
import { useSettings } from '@renderer/stores/settings'

/** Líneas presentes en `next` que no estaban en `prev` (aproximación para marcar el margen). */
function addedLines(prev: string, next: string): number[] {
  const counts = new Map<string, number>()
  for (const l of prev.split('\n')) counts.set(l, (counts.get(l) ?? 0) + 1)
  const out: number[] = []
  next.split('\n').forEach((l, i) => {
    const c = counts.get(l) ?? 0
    if (c > 0) counts.set(l, c - 1)
    else if (l.trim()) out.push(i + 1)
  })
  return out
}

export default function CodeEditor({ path, diff }: { path: string; diff: boolean }) {
  const value = useWorkspace((s) => s.files[path]?.content ?? '')
  const original = useWorkspace((s) => s.files[path]?.original)
  const changedBy = useWorkspace((s) => s.files[path]?.changedBy)
  const fontSize = useSettings((s) => s.editorFontSize)
  const tabSize = useSettings((s) => s.editorTabSize)
  const wordWrap = useSettings((s) => s.editorWordWrap)
  const minimap = useSettings((s) => s.editorMinimap)
  const decoRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const reveal = useWorkspace((s) => (s.reveal?.rel === path ? s.reveal : null))

  // Ir a una línea (desde el panel Problemas)
  useEffect(() => {
    const ed = editorRef.current
    if (!reveal || !ed) return
    ed.revealLineInCenter(reveal.line)
    ed.setPosition({ lineNumber: reveal.line, column: 1 })
    ed.focus()
  }, [reveal])
  const lang = languageOf(path).id

  const options: monaco.editor.IStandaloneEditorConstructionOptions = {
    fontFamily: '"Geist Mono Variable", "Cascadia Code", Consolas, monospace',
    fontSize,
    lineHeight: Math.round(fontSize * 1.6),
    fontLigatures: true,
    minimap: { enabled: minimap, renderCharacters: false },
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    cursorBlinking: 'smooth',
    cursorSmoothCaretAnimation: 'on',
    renderLineHighlight: 'all',
    padding: { top: 10 },
    guides: { indentation: true },
    stickyScroll: { enabled: true },
    bracketPairColorization: { enabled: true },
    automaticLayout: true,
    tabSize,
    wordWrap: wordWrap ? 'on' : 'off',
  }

  const onMount: OnMount = (editor) => {
    editorRef.current = editor
    // Guardar: Ctrl+S / ⌘S. Se lee el estado en el momento de pulsar (no el del montaje).
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      const active = useWorkspace.getState().activeTab
      if (active) void useWorkspace.getState().save(active)
    })
    decoRef.current = editor.createDecorationsCollection()
  }

  // Marcas en el margen para las líneas añadidas por el agente (demo; en la Fase 7, desde los changesets reales)
  useEffect(() => {
    if (diff || !decoRef.current) return
    if (changedBy !== 'agent' || original === undefined) {
      decoRef.current.clear()
      return
    }
    decoRef.current.set(
      addedLines(original, value).map((line) => ({
        range: new monaco.Range(line, 1, line, 1),
        options: { isWholeLine: true, linesDecorationsClassName: 'zh-gutter-agent', className: 'zh-line-agent' },
      })),
    )
  }, [value, original, changedBy, diff, path])

  if (diff && original !== undefined) {
    return (
      <DiffEditor
        key={`diff:${path}`}
        theme={THEME}
        language={lang}
        original={original}
        modified={value}
        originalModelPath={`original:///${path}`}
        modifiedModelPath={`file:///${path}`}
        options={{ ...options, renderSideBySide: true, readOnly: false, originalEditable: false, minimap: { enabled: false }, renderOverviewRuler: false }}
      />
    )
  }

  return (
    <Editor
      theme={THEME}
      path={`file:///${path}`}
      language={lang}
      value={value}
      onMount={onMount}
      onChange={(v) => useWorkspace.getState().updateBuffer(path, v ?? '')}
      options={options}
      loading={null}
    />
  )
}
