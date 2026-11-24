import { useEffect, useRef, useState } from 'react'
import { Ellipsis, FileUp, GitCompare, Sparkles } from 'lucide-react'
import { IconButton } from '@renderer/components/ui/Button'
import { useChat } from '@renderer/stores/chat'
import { useWorkspace } from '@renderer/stores/workspace'
import { useLayout } from '@renderer/stores/layout'
import { Composer } from './Composer'
import { LiveMessage, Message } from './Message'
import { useSettings } from '@renderer/stores/settings'

const SUGGESTIONS = [
  'Explícame la estructura de este proyecto',
  'Añade pruebas para useSales.ts',
  'Busca y corrige errores de TypeScript',
  'Crea una página de login con validación',
]

export function ChatPanel() {
  const conv = useChat((s) => s.conversations.find((c) => c.id === s.activeId))
  const messages = useChat((s) => (s.activeId ? s.messages[s.activeId] : undefined))
  const live = useChat((s) => (s.activeId ? s.live[s.activeId] : undefined))
  const numCtx = useSettings((s) => s.numCtx)
  const lastMetrics = messages?.findLast((m) => m.metrics)?.metrics
  const usedTokens = lastMetrics ? lastMetrics.promptTokens + lastMetrics.evalTokens : 0
  const project = useWorkspace((s) => s.project)
  const [dragging, setDragging] = useState(false)
  const depth = useRef(0)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [conv?.id, messages?.length])

  // Seguir el texto en streaming si el usuario está al final
  useEffect(() => {
    const el = scrollRef.current
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight
  }, [live?.text, live?.state])

  return (
    <section
      className="relative flex h-full min-w-0 flex-col bg-bg-1"
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        depth.current++
        setDragging(true)
      }}
      onDragOver={(e) => e.dataTransfer.types.includes('Files') && e.preventDefault()}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1)
        if (depth.current === 0) setDragging(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        depth.current = 0
        setDragging(false)
        useChat.getState().addFiles(Array.from(e.dataTransfer.files))
      }}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="truncate font-semibold">{conv?.title ?? 'Chat'}</span>
        {project && <span className="truncate text-small text-fg-3">· {project.name}</span>}
        {usedTokens > 0 && (
          <span className="ml-2 flex shrink-0 items-center gap-2" title="Contexto usado en el último turno respecto a la ventana de contexto configurada">
            <span className="h-1 w-16 overflow-hidden rounded-full bg-bg-4">
              <span className={usedTokens / numCtx > 0.8 ? 'block h-full bg-warn' : 'block h-full bg-accent'} style={{ width: `${Math.min(100, (usedTokens / numCtx) * 100)}%` }} />
            </span>
            <span className="font-mono text-tiny text-fg-3">
              {(usedTokens / 1000).toLocaleString('es-ES', { maximumFractionDigits: 1 })}k / {Math.round(numCtx / 1024)}k
            </span>
          </span>
        )}
        <div className="ml-auto flex gap-0.5">
          <IconButton label="Ver cambios en el editor" icon={<GitCompare />} onClick={() => useLayout.getState().show('workbench')} />
          <IconButton label="Más opciones" icon={<Ellipsis />} lockedPhase={3} />
        </div>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        {conv && messages && (messages.length > 0 || live) ? (
          <div className="mx-auto flex max-w-[760px] flex-col gap-6 px-5 pt-5 pb-3">
            {messages.map((m) => (
              <Message key={m.id} m={m} />
            ))}
            {live && <LiveMessage reply={live} />}
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
            <span className="grid size-10 place-items-center rounded-lg bg-agent-soft text-agent">
              <Sparkles className="size-5" />
            </span>
            <div className="text-title font-semibold">¿Qué construimos hoy?</div>
            <div className="max-w-sm text-small text-fg-3">
              Describe la tarea en lenguaje natural. El agente explorará el proyecto, propondrá cambios y verás cada paso en el panel de actividad.
            </div>
            <div className="mt-2 flex max-w-md flex-wrap justify-center gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => useChat.getState().setDraft(s)}
                  className="rounded-md border border-line bg-bg-2 px-2.5 py-1 text-small text-fg-2 hover:border-line-strong hover:text-fg-1"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <Composer />

      {dragging && (
        <div className="pointer-events-none absolute inset-2 z-10 flex animate-fade-in flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-accent/60 bg-bg-1/90 text-fg-1">
          <FileUp className="size-6 text-accent" />
          <div className="font-medium">Suelta los archivos para adjuntarlos</div>
          <div className="text-small text-fg-3">PDF, DOCX, XLSX, CSV, imágenes, código o ZIP · máx. 50 MB por archivo</div>
        </div>
      )}
    </section>
  )
}
