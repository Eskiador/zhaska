import { useEffect, useState } from 'react'
import { Check, Copy, ExternalLink } from 'lucide-react'
import { IconButton } from '@renderer/components/ui/Button'
import { FileIcon } from '@renderer/features/explorer/fileIcons'
import { knownFiles, useWorkspace } from '@renderer/stores/workspace'

/** Bloque de código del chat, resaltado con el mismo motor y tema que el editor (Monaco colorize). */
export function CodeBlock({ code, lang, path }: { code: string; lang: string; path?: string }) {
  const [html, setHtml] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const exists = useWorkspace((s) => (path ? !!s.files[path] || knownFiles(s.dirs).includes(path) : false))

  useEffect(() => {
    let alive = true
    void import('@renderer/features/editor/monaco').then((m) => m.colorize(code, lang)).then((h) => alive && setHtml(h))
    return () => {
      alive = false
    }
  }, [code, lang])

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-line bg-bg-0">
      <div className="flex h-8 items-center gap-2 border-b border-line pr-1.5 pl-3 text-small text-fg-3">
        {path ? <FileIcon name={path} /> : null}
        <span className="truncate font-mono text-tiny">{path ?? lang}</span>
        <div className="ml-auto flex gap-0.5">
          <IconButton
            size="sm"
            label={copied ? 'Copiado' : 'Copiar'}
            icon={copied ? <Check className="text-ok" /> : <Copy />}
            onClick={() => {
              void navigator.clipboard?.writeText(code)
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            }}
          />
          {path && exists && <IconButton size="sm" label="Abrir en el editor" icon={<ExternalLink />} onClick={() => void useWorkspace.getState().openFile(path)} />}
        </div>
      </div>
      {html ? (
        <pre className="selectable overflow-x-auto px-3 py-2.5 font-mono text-small leading-[1.65]" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="selectable overflow-x-auto px-3 py-2.5 font-mono text-small leading-[1.65] text-fg-2">{code}</pre>
      )}
    </div>
  )
}
