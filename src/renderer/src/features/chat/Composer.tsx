import { useShallow } from 'zustand/react/shallow'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowUp, AtSign, Bot, ChevronDown, Lock, MessageSquare, Paperclip, ShieldCheck } from 'lucide-react'
import { IconButton } from '@renderer/components/ui/Button'
import { Tooltip } from '@renderer/components/ui/Tooltip'
import { openMenuAt } from '@renderer/components/ui/overlays'
import { cn } from '@renderer/lib/cn'
import { isMod } from '@renderer/lib/platform'
import { isInstalled, useOllama } from '@renderer/stores/ollama'
import { ModelPicker } from './ModelPicker'
import { FileIcon } from '@renderer/features/explorer/fileIcons'
import { useActivity } from '@renderer/stores/activity'
import { useChat } from '@renderer/stores/chat'
import { AUTONOMY_LABEL, useSettings, type Autonomy } from '@renderer/stores/settings'
import { useUI } from '@renderer/stores/ui'
import { knownFiles, useWorkspace } from '@renderer/stores/workspace'
import { AttachmentCard } from './AttachmentCard'
import { EXT_KIND } from '@shared/attachments'
import { usePreview } from './preview'

/** Formatos del selector (cualquier otro archivo de texto también se admite al arrastrarlo). */
export const ACCEPT = Object.keys(EXT_KIND)
  .map((e) => `.${e}`)
  .join(',')

export function Composer() {
  const draft = useChat((s) => s.draft)
  const attachments = useChat((s) => s.attachments)
  const insertRequest = useChat((s) => s.insertRequest)
  const { setDraft, addFiles, removeAttachment } = useChat.getState()
  const demoRunning = useActivity((s) => s.state.status === 'running')
  const project = useWorkspace((s) => s.project)
  const activeId = useChat((s) => s.activeId)
  const live = useChat((s) => (s.activeId ? s.live[s.activeId] : undefined))
  const ollamaState = useOllama((s) => s.status?.state)
  const modelReady = useOllama((s) => isInstalled(s.installed, useSettings.getState().activeModel))
  const running = !!live || (project?.demo === true && demoRunning)
  const [pickerAnchor, setPickerAnchor] = useState<HTMLElement | null>(null)
  const modelBtn = useRef<HTMLButtonElement>(null)
  const model = useSettings((s) => s.activeModel)
  const mode = useSettings((s) => s.autonomy)
  const composerMode = useSettings((s) => s.composerMode)
  const files = useWorkspace(useShallow((s) => knownFiles(s.dirs)))
  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null)
  const [mentionIdx, setMentionIdx] = useState(0)
  const preview = usePreview()

  // Auto-altura del textarea
  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = '0px'
    ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`
  }, [draft])

  // Inserciones externas (p. ej. "Mencionar en el chat" desde el explorador)
  useEffect(() => {
    if (!insertRequest) return
    const ta = taRef.current
    const cur = useChat.getState().draft
    const pos = ta?.selectionStart ?? cur.length
    const next = cur.slice(0, pos) + insertRequest.text + cur.slice(pos)
    setDraft(next)
    requestAnimationFrame(() => {
      ta?.focus()
      ta?.setSelectionRange(pos + insertRequest.text.length, pos + insertRequest.text.length)
    })
  }, [insertRequest, setDraft])

  const suggestions = useMemo(() => {
    if (!mention) return []
    const q = mention.query.toLowerCase()
    return files.filter((f) => f.toLowerCase().includes(q)).slice(0, 8)
  }, [mention, files])

  const detectMention = (value: string, caret: number) => {
    const m = /(?:^|\s)@([\w./-]*)$/.exec(value.slice(0, caret))
    if (m) {
      setMention({ query: m[1]!, start: caret - m[1]!.length - 1 })
      setMentionIdx(0)
    } else setMention(null)
  }

  const applyMention = (path: string) => {
    if (!mention) return
    const caret = taRef.current?.selectionStart ?? draft.length
    const next = `${draft.slice(0, mention.start)}@${path} ${draft.slice(caret)}`
    setDraft(next)
    setMention(null)
    const pos = mention.start + path.length + 2
    requestAnimationFrame(() => taRef.current?.setSelectionRange(pos, pos))
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && suggestions.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionIdx((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        applyMention(suggestions[mentionIdx]!)
        return
      }
      if (e.key === 'Escape') {
        setMention(null)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submit()
    }
  }

  /** Motivo por el que no se puede enviar (o null si se puede). */
  const blocker: { text: string; fix?: () => void } | null = project?.demo
    ? null
    : ollamaState !== 'connected'
      ? { text: 'Ollama no está conectado', fix: () => useUI.getState().openDialog('settings', 'ollama') }
      : !modelReady
        ? { text: `${model} no está descargado`, fix: () => useUI.getState().openDialog('models') }
        : null

  const submit = async () => {
    const text = draft.trim()
    if (!text || running || !project) return
    if (blocker) return blocker.fix?.()
    setDraft('')
    const ok = await useChat.getState().send(project.id, text, model)
    if (!ok) setDraft(text)
  }

  // Esc detiene la respuesta en curso; Ctrl/⌘+M abre el selector de modelo
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && live && activeId) void useChat.getState().cancel(activeId)
      if (isMod(e) && e.key.toLowerCase() === 'm') {
        e.preventDefault()
        setPickerAnchor((a) => (a ? null : modelBtn.current))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [live, activeId])

  return (
    <div className="relative mx-4 mb-4">
      {mention && suggestions.length > 0 && (
        <div className="absolute right-0 bottom-full left-0 mb-2 animate-pop-in overflow-hidden rounded-lg border border-line-strong bg-bg-2 p-1 shadow-pop">
          <div className="px-2 py-1 text-micro font-semibold tracking-[0.07em] text-fg-3 uppercase">Archivos del proyecto</div>
          {suggestions.map((f, i) => (
            <button
              key={f}
              type="button"
              onMouseEnter={() => setMentionIdx(i)}
              onMouseDown={(e) => {
                e.preventDefault()
                applyMention(f)
              }}
              className={cn('flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px]', i === mentionIdx ? 'bg-bg-3 text-fg-1' : 'text-fg-2')}
            >
              <FileIcon name={f} />
              <span className="truncate">{f.split('/').pop()}</span>
              <span className="ml-auto truncate font-mono text-micro text-fg-3">{f}</span>
            </button>
          ))}
        </div>
      )}

      <div className="rounded-xl border border-line bg-bg-2 shadow-[0_8px_24px_rgb(0_0_0/0.25)] focus-within:border-accent/60">
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 px-2.5 pt-2.5">
            {attachments.map((a) => (
              <AttachmentCard key={a.id} a={a} compact onRemove={() => removeAttachment(a.id)} onOpen={() => preview(a)} />
            ))}
          </div>
        )}
        <textarea
          ref={taRef}
          value={draft}
          rows={2}
          placeholder={running ? 'Espera a que termine la respuesta o pulsa Esc para detenerla…' : 'Pide un cambio o escribe @ para mencionar archivos…'}
          onChange={(e) => {
            setDraft(e.target.value)
            detectMention(e.target.value, e.target.selectionStart)
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setTimeout(() => setMention(null), 120)}
          onPaste={(e) => {
            const pasted = Array.from(e.clipboardData.files)
            if (pasted.length) {
              e.preventDefault()
              addFiles(pasted)
            }
          }}
          className="selectable block max-h-[220px] min-h-[52px] w-full resize-none bg-transparent px-3 py-2.5 text-body text-fg-1 outline-none placeholder:text-fg-3"
        />
        <div className="flex items-center gap-1 border-t border-line px-2 py-1.5">
          <input
            ref={fileRef}
            type="file"
            multiple
            accept={ACCEPT}
            hidden
            onChange={(e) => {
              addFiles(Array.from(e.target.files ?? []))
              e.target.value = ''
            }}
          />
          <IconButton label="Adjuntar archivos" icon={<Paperclip />} side="top" onClick={() => fileRef.current?.click()} />
          <IconButton
            label="Mencionar archivo"
            icon={<AtSign />}
            side="top"
            onClick={() => {
              const ta = taRef.current
              if (!ta) return
              const pos = ta.selectionStart
              const prefix = pos > 0 && !/\s/.test(draft[pos - 1]!) ? ' @' : '@'
              const next = draft.slice(0, pos) + prefix + draft.slice(pos)
              setDraft(next)
              ta.focus()
              requestAnimationFrame(() => {
                ta.setSelectionRange(pos + prefix.length, pos + prefix.length)
                detectMention(next, pos + prefix.length)
              })
            }}
          />
          <button
            ref={modelBtn}
            type="button"
            onClick={(e) => setPickerAnchor(pickerAnchor ? null : e.currentTarget)}
            className={cn('flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-small hover:bg-bg-3', pickerAnchor ? 'border-accent/70 text-fg-1' : 'border-line-subtle text-fg-2')}
          >
            <span className={cn('size-1.5 rounded-full', ollamaState === 'connected' && modelReady ? 'bg-ok' : 'bg-fg-disabled')} />
            <span className="font-mono text-tiny">{model.replace(/-it-qat$/, '')}</span>
            <ChevronDown className={cn('size-3 transition-transform', pickerAnchor && 'rotate-180')} />
          </button>
          {pickerAnchor && <ModelPicker anchor={pickerAnchor} onClose={() => setPickerAnchor(null)} />}
          <button
            type="button"
            className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-small text-fg-2 hover:bg-bg-3 hover:text-fg-1"
            onClick={(e) =>
              openMenuAt(e.currentTarget, [
                { id: 'agent', label: 'Agente · usa herramientas en el proyecto', icon: <Bot />, checked: composerMode === 'agent', onSelect: () => useSettings.getState().set('composerMode', 'agent') },
                { id: 'chat', label: 'Solo chat · sin tocar archivos', icon: <MessageSquare />, checked: composerMode === 'chat', onSelect: () => useSettings.getState().set('composerMode', 'chat') },
              ])
            }
          >
            {composerMode === 'agent' ? <Bot className="size-3.5 text-agent" /> : <MessageSquare className="size-3.5" />}
            {composerMode === 'agent' ? 'Agente' : 'Solo chat'}
            <ChevronDown className="size-3" />
          </button>
          <button
            type="button"
            title={`Autonomía del agente: ${AUTONOMY_LABEL[mode]}`}
            className="grid size-7 place-items-center rounded-lg text-fg-2 hover:bg-bg-3 hover:text-fg-1"
            onClick={(e) =>
              openMenuAt(
                e.currentTarget,
                (Object.keys(AUTONOMY_LABEL) as Autonomy[]).map((m) => ({
                  id: m,
                  label: AUTONOMY_LABEL[m],
                  checked: m === mode,
                  onSelect: () => useSettings.getState().setAutonomy(m),
                })),
              )
            }
          >
            <ShieldCheck className="size-4 text-accent" />
          </button>

          {running ? (
            <button
              type="button"
              onClick={() => (live && activeId ? void useChat.getState().cancel(activeId) : useActivity.getState().stop())}
              className="ml-auto flex h-8 items-center gap-2 rounded-lg border border-line bg-bg-3 px-3 text-body hover:bg-bg-4"
            >
              <span className="font-mono text-micro text-fg-3">Esc</span>
              <span className="size-2 rounded-[2px] bg-fg-1" />
              Detener
            </button>
          ) : (
            <Tooltip content={blocker ? `${blocker.text}. Pulsa para solucionarlo.` : 'Enviar (↵)'} side="top">
              <button
                type="button"
                aria-label="Enviar"
                onClick={() => void submit()}
                className={cn(
                  'ml-auto grid size-8 place-items-center rounded-full text-white transition-opacity',
                  blocker ? 'bg-bg-4 text-fg-3' : 'bg-accent-solid hover:bg-accent-hover',
                  !blocker && !draft.trim() && 'opacity-40',
                )}
              >
                {blocker ? <Lock className="size-3.5" /> : <ArrowUp className="size-4" />}
              </button>
            </Tooltip>
          )}
        </div>
      </div>
      <div className="mt-1.5 flex items-center justify-between px-1 text-tiny text-fg-3">
        <span className="flex items-center gap-1.5">
          <Lock className="size-3" /> Todo se procesa en este equipo con Ollama
        </span>
        <span>↵ enviar · ⇧↵ nueva línea</span>
      </div>
    </div>
  )
}
