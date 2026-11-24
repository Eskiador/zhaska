import { Fragment } from 'react'
import { knownFiles, useWorkspace } from '@renderer/stores/workspace'

/**
 * Texto del chat con `código en línea` y @menciones de archivos.
 * El Markdown completo (react-markdown, sin HTML crudo) llega en la Fase 4 con las respuestas reales.
 */
export function RichText({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`|@[\w./-]+\.[a-z0-9]+)/gi)
  return (
    <>
      {parts.map((p, i) => {
        if (p.startsWith('`') && p.endsWith('`') && p.length > 1)
          return (
            <code key={i} className="rounded-sm bg-bg-3 px-1 py-px font-mono text-[11.5px] text-fg-1">
              {p.slice(1, -1)}
            </code>
          )
        if (p.startsWith('@')) return <Mention key={i} path={p.slice(1)} />
        return <Fragment key={i}>{p}</Fragment>
      })}
    </>
  )
}

function Mention({ path }: { path: string }) {
  const exists = useWorkspace((s) => !!s.files[path] || knownFiles(s.dirs).includes(path))
  return (
    <button
      type="button"
      onClick={() => exists && void useWorkspace.getState().openFile(path)}
      className="rounded-sm bg-accent-soft px-1 font-mono text-[11.5px] text-accent hover:underline"
    >
      @{path.split('/').pop()}
    </button>
  )
}
