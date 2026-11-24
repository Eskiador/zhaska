import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUp,
  BookOpenText,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Database,
  Download,
  EyeOff,
  FileText,
  FolderPlus,
  Library,
  Lock,
  MessageSquarePlus,
  Paperclip,
  Pencil,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Square,
  Trash,
  X,
} from 'lucide-react'
import type { AssistantMessage, KbCollection } from '@shared/ipc/contract'
import { ASSISTANT_TEMPLATES, isChatModel, type AssistantSource } from '@shared/assistant'
import { Button, IconButton } from '@renderer/components/ui/Button'
import { Badge, Select, Spinner, Switch, TextInput } from '@renderer/components/ui/primitives'
import { Dialog, openContextMenu, openMenuAt } from '@renderer/components/ui/overlays'
import { confirm } from '@renderer/components/ui/confirm'
import { cn } from '@renderer/lib/cn'
import { useAssistant, type AssistantLive } from '@renderer/stores/assistant'
import { useSettings } from '@renderer/stores/settings'
import { isInstalled, useOllama } from '@renderer/stores/ollama'
import { relativeTime } from '@renderer/features/sidebar/Sidebar'
import { MarkdownView } from '@renderer/features/chat/Markdown'
import { RichText } from '@renderer/features/chat/RichText'
import { ErrorBlock } from '@renderer/features/chat/Message'
import { AttachmentCard } from '@renderer/features/chat/AttachmentCard'
import { usePreview } from '@renderer/features/chat/preview'

/**
 * Asistente de oficina (Fase 12): chat aparte del de programación para preguntar a tus documentos, resumir,
 * redactar y traducir. Sin herramientas y sin conexión fuera del equipo.
 */
export function AssistantView() {
  const ready = useAssistant((s) => s.ready)
  useEffect(() => {
    void useAssistant.getState().init()
  }, [])
  if (!ready)
    return (
      <div className="grid flex-1 place-items-center">
        <Spinner />
      </div>
    )
  return (
    <div className="flex min-h-0 flex-1">
      <AssistantChat />
      <KnowledgeDialog />
      <NewCollectionDialog />
    </div>
  )
}

/* ───────────── Columna izquierda: conversaciones y bases ───────────── */

/** Contenido de la barra lateral en el modo Chat (la barra la pone Sidebar, como en el modo Código). */
export function AssistantSidebar() {
  const conversations = useAssistant((s) => s.conversations)
  const collections = useAssistant((s) => s.collections)
  const activeId = useAssistant((s) => s.activeId)
  const live = useAssistant((s) => s.live)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex gap-1.5 px-2.5 pb-3">
        <Button className="flex-1" icon={<MessageSquarePlus />} onClick={() => void useAssistant.getState().newConversation()}>
          Nueva
        </Button>
        <Button variant="secondary" icon={<EyeOff />} title="Conversación privada: no se guarda nada en disco y desaparece al cerrar ZHASKA" onClick={() => void useAssistant.getState().newConversation({ private: true })}>
          Privada
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <div className="px-2 pt-1 pb-1.5 text-micro font-semibold tracking-[0.06em] text-fg-3 uppercase">Conversaciones</div>
        {conversations.length === 0 && <div className="px-2 text-small text-fg-3">Todavía no hay conversaciones.</div>}
        {conversations.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => void useAssistant.getState().select(c.id)}
            onContextMenu={(e) =>
              openContextMenu(e, [
                ...(!c.private
                  ? [
                      {
                        id: 'rename',
                        label: 'Renombrar',
                        icon: <Pencil />,
                        onSelect: () => {
                          const t = window.prompt('Nuevo nombre de la conversación', c.title)
                          if (t) void useAssistant.getState().rename(c.id, t)
                        },
                      },
                    ]
                  : []),
                {
                  id: 'delete',
                  label: 'Eliminar',
                  icon: <Trash />,
                  danger: true,
                  onSelect: () =>
                    void confirm({ title: 'Eliminar conversación', description: `«${c.title}» y sus mensajes se borrarán. Los documentos no se tocan.`, confirmLabel: 'Eliminar', danger: true }).then(
                      (ok) => {
                        if (ok) void useAssistant.getState().remove(c.id)
                      },
                    ),
                },
              ])
            }
            className={cn('group flex h-[30px] w-full items-center gap-2 rounded-md px-2 text-left text-body', c.id === activeId ? 'bg-bg-3 text-fg-1' : 'text-fg-2 hover:bg-bg-2 hover:text-fg-1')}
          >
            {c.private ? <EyeOff className="size-3.5 shrink-0 text-fg-3" /> : <BookOpenText className="size-3.5 shrink-0 text-fg-3" />}
            <span className="flex-1 truncate">{c.title}</span>
            {live[c.id] ? <Spinner size={11} /> : <span className="text-tiny text-fg-3">{relativeTime(c.updatedAt)}</span>}
          </button>
        ))}

        <div className="mt-4 flex items-center px-2 pb-1.5">
          <span className="flex-1 text-micro font-semibold tracking-[0.06em] text-fg-3 uppercase">Bases de conocimiento</span>
          <IconButton size="sm" label="Nueva base de conocimiento" icon={<FolderPlus />} onClick={() => useAssistant.getState().setNewKb(true)} />
        </div>
        {collections.length === 0 && (
          <div className="mx-2 rounded-lg border border-dashed border-line p-3 text-small text-fg-3">
            Crea una base y añade carpetas con tus documentos (PDF, Word, Excel…). Se leen aquí, en tu equipo; nunca se modifican ni se envían.
          </div>
        )}
        {collections.map((c) => (
          <CollectionRow key={c.id} c={c} />
        ))}
      </div>

      <div className="mx-2.5 mb-2 flex items-start gap-2 rounded-md bg-bg-2 px-2.5 py-2 text-tiny text-fg-3">
        <ShieldCheck className="mt-px size-3.5 shrink-0 text-ok" />
        <span>Todo se procesa en este equipo. Sin internet y sin servicios externos.</span>
      </div>
    </div>
  )
}

function CollectionRow({ c }: { c: KbCollection }) {
  const p = c.indexing
  return (
    <button type="button" onClick={() => useAssistant.getState().openKb(c.id)} className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-bg-2">
      <Library className="mt-0.5 size-3.5 shrink-0 text-fg-3" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-body text-fg-1">{c.name}</span>
          {c.confidential && <Lock className="size-3 shrink-0 text-warn" />}
        </span>
        <span className="block truncate text-tiny text-fg-3">
          {p ? (p.phase === 'scanning' ? 'Buscando documentos…' : `Indexando ${p.done + 1} de ${p.total}`) : `${c.documents} documento${c.documents === 1 ? '' : 's'}${c.errors ? ` · ${c.errors} con error` : ''}`}
        </span>
      </span>
      {p && <Spinner size={11} />}
    </button>
  )
}

function NewCollectionDialog() {
  const open = useAssistant((s) => s.newKb)
  const onClose = () => useAssistant.getState().setNewKb(false)
  const [name, setName] = useState('')
  const [confidential, setConfidential] = useState(false)
  const create = async () => {
    const id = await useAssistant.getState().createCollection(name.trim(), confidential)
    if (!id) return
    setName('')
    setConfidential(false)
    onClose()
    useAssistant.getState().openKb(id)
    void useAssistant.getState().addFolder(id)
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Nueva base de conocimiento"
      icon={<Library />}
      width={480}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={!name.trim()} onClick={() => void create()}>
            Crear y elegir carpeta
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 p-4">
        <label className="flex flex-col gap-1.5 text-small text-fg-2">
          Nombre
          <TextInput autoFocus value={name} maxLength={80} placeholder="Por ejemplo: Procedimientos de Back Office" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && void create()} />
        </label>
        <div className="flex items-start gap-3">
          <div className="flex-1">
            <div className="text-body text-fg-1">Confidencial</div>
            <div className="text-small text-fg-3">Lo que preguntes sobre esta base nunca se guarda en disco: solo se puede usar en conversaciones privadas.</div>
          </div>
          <Switch checked={confidential} onChange={setConfidential} />
        </div>
        <div className="rounded-lg bg-bg-2 p-3 text-small text-fg-2">
          Después eliges una o varias carpetas. ZHASKA lee sus documentos en este equipo, guarda un índice para buscar en ellos y se pone al día solo cuando cambian. Los archivos nunca se modifican, se mueven ni se envían.
        </div>
      </div>
    </Dialog>
  )
}

/* ───────────── Detalle de una base ───────────── */

function KnowledgeDialog() {
  const id = useAssistant((s) => s.kbOpen)
  const c = useAssistant((s) => s.collections.find((x) => x.id === s.kbOpen))
  const docs = useAssistant((s) => (s.kbOpen ? s.documents[s.kbOpen] : undefined))
  const embedModel = useSettings((s) => s.embedModel)
  const installed = useOllama((s) => s.installed)
  const pull = useOllama((s) => s.pulls[embedModel])
  const close = () => useAssistant.getState().openKb(null)
  const st = useAssistant.getState()
  if (!id || !c) return null
  const needsModel = !isInstalled(installed, embedModel)
  const errors = docs?.filter((d) => d.status === 'error') ?? []
  return (
    <Dialog
      open
      onClose={close}
      title={c.name}
      icon={<Library />}
      width={720}
      footer={
        <>
          <Button
            variant="danger"
            icon={<Trash />}
            className="mr-auto"
            onClick={() =>
              void confirm({
                title: 'Borrar base de conocimiento',
                description: `Se borra el índice de «${c.name}». Tus documentos y carpetas no se tocan.`,
                confirmLabel: 'Borrar',
                danger: true,
              }).then((ok) => {
                if (ok) void st.deleteCollection(c.id)
              })
            }
          >
            Borrar base
          </Button>
          <Button variant="secondary" icon={<RefreshCw />} disabled={!!c.indexing} onClick={() => void st.reindex(c.id)}>
            Actualizar
          </Button>
          <Button icon={<FolderPlus />} onClick={() => void st.addFolder(c.id)}>
            Añadir carpeta
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 p-4">
        {needsModel && (
          <div className="flex items-start gap-2.5 rounded-lg border border-warn/35 bg-warn-soft px-3 py-2.5 text-small">
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-warn" />
            <div className="flex-1">
              <div className="text-fg-1">Falta el modelo de búsqueda ({embedModel})</div>
              <div className="text-fg-2">Es un modelo pequeño (≈ 620 MB) que convierte tus documentos en un índice para buscar por significado. Funciona en local, como Gemma.</div>
            </div>
            <Button size="sm" icon={<Download />} disabled={!!pull && !['done', 'error', 'cancelled'].includes(pull.phase)} onClick={() => void useOllama.getState().pull(embedModel)}>
              {pull && pull.total && !['done', 'error', 'cancelled'].includes(pull.phase) ? `${Math.round((pull.completed / pull.total) * 100)} %` : 'Descargar'}
            </Button>
          </div>
        )}
        <div className="flex items-start gap-3">
          <div className="flex-1">
            <div className="text-body text-fg-1">Confidencial</div>
            <div className="text-small text-fg-3">Solo en conversaciones privadas: lo que preguntes y las respuestas nunca se guardan en disco.</div>
          </div>
          <Switch checked={c.confidential} onChange={(v) => void st.updateCollection(c.id, { confidential: v })} />
        </div>

        <div>
          <div className="mb-1.5 text-micro font-semibold tracking-[0.06em] text-fg-3 uppercase">Carpetas (solo lectura)</div>
          {c.folders.length === 0 && <div className="text-small text-fg-3">Sin carpetas. Pulsa «Añadir carpeta».</div>}
          {c.folders.map((f) => (
            <div key={f.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-bg-2">
              <Database className="size-3.5 shrink-0 text-fg-3" />
              <span className="flex-1 truncate font-mono text-small text-fg-2" title={f.path}>
                {f.path}
              </span>
              <IconButton size="sm" label="Quitar carpeta (borra su índice, no los archivos)" icon={<X />} onClick={() => void st.removeFolder(f.id)} />
            </div>
          ))}
        </div>

        {c.indexing && (
          <div className="flex items-center gap-2 rounded-lg bg-bg-2 px-3 py-2 text-small text-fg-2">
            <Spinner size={12} />
            {c.indexing.phase === 'scanning' ? 'Buscando documentos…' : `Leyendo ${c.indexing.done + 1} de ${c.indexing.total}: ${c.indexing.current ?? ''}`}
          </div>
        )}

        <div>
          <div className="mb-1.5 flex items-center text-micro font-semibold tracking-[0.06em] text-fg-3 uppercase">
            <span className="flex-1">Documentos indexados ({c.documents})</span>
            {errors.length > 0 && <span className="text-err normal-case">{errors.length} con error</span>}
          </div>
          <div className="max-h-[300px] overflow-y-auto rounded-lg border border-line-subtle">
            {!docs && (
              <div className="p-3">
                <Spinner size={12} />
              </div>
            )}
            {docs?.length === 0 && <div className="p-3 text-small text-fg-3">Ningún documento todavía. Se admiten PDF (también escaneados), Word, Excel, CSV, texto e imágenes.</div>}
            {docs?.map((d) => (
              <div key={d.id} className="flex items-start gap-2 border-b border-line-subtle px-3 py-1.5 last:border-b-0">
                <FileText className={cn('mt-0.5 size-3.5 shrink-0', d.status === 'error' ? 'text-err' : 'text-fg-3')} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-small text-fg-1" title={d.relPath}>
                    {d.relPath}
                  </div>
                  {d.status === 'error' ? <div className="text-tiny text-err">{d.error}</div> : <div className="text-tiny text-fg-3">{[d.pages ? `${d.pages} pág.` : null, `${d.chunks} fragmentos`, relativeTime(d.indexedAt)].filter(Boolean).join(' · ')}</div>}
                </div>
                {d.status === 'indexed' && (
                  <button type="button" className="text-tiny text-accent hover:underline" onClick={() => void st.openDocument(d.id)}>
                    Abrir
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </Dialog>
  )
}

/* ───────────── Chat ───────────── */

const STATE_LABEL: Record<AssistantLive['state'], string> = {
  searching: 'Buscando en tus documentos…',
  loading: 'Cargando el modelo…',
  prompt: 'Leyendo los fragmentos…',
  thinking: 'Pensando…',
  generating: 'Escribiendo…',
}

/** Para el chat del asistente se mide que basta Gemma 4 E4B (12/12 igual que el 12B y 2–4 veces más rápido): por defecto, si está instalado. */
export const ASSISTANT_DEFAULT_MODEL = 'gemma4:e4b-it-qat'

function useAssistantModel() {
  const assistantModel = useSettings((s) => s.assistantModel)
  const activeModel = useSettings((s) => s.activeModel)
  const hasFast = useOllama((s) => isInstalled(s.installed, ASSISTANT_DEFAULT_MODEL))
  return assistantModel || (hasFast ? ASSISTANT_DEFAULT_MODEL : activeModel)
}

function AssistantChat() {
  const conv = useAssistant((s) => s.conversations.find((c) => c.id === s.activeId))
  const messages = useAssistant((s) => (s.activeId ? s.messages[s.activeId] : undefined))
  const live = useAssistant((s) => (s.activeId ? s.live[s.activeId] : undefined))
  const collections = useAssistant((s) => s.collections)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [conv?.id, messages?.length])
  useEffect(() => {
    const el = scrollRef.current
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight
  }, [live?.text, live?.state])

  const used = collections.filter((c) => conv?.collectionIds.includes(c.id))

  return (
    <section
      className="relative flex min-w-0 flex-1 flex-col bg-bg-1"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        useAssistant.getState().addFiles(Array.from(e.dataTransfer.files))
      }}
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-4">
        {conv?.private && (
          <Badge tone="warn">
            <EyeOff /> Privada
          </Badge>
        )}
        <span className="truncate font-semibold">{conv?.title ?? 'Asistente de oficina'}</span>
        <div className="ml-auto flex items-center gap-2">
          <CollectionsPicker />
          <ModelSelect />
        </div>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        {messages && (messages.length > 0 || live) ? (
          <div className="mx-auto flex max-w-[780px] flex-col gap-6 px-5 pt-5 pb-3">
            {messages.map((m) => (
              <AssistantMessageView key={m.id} m={m} />
            ))}
            {live && <LiveView live={live} />}
          </div>
        ) : (
          <EmptyAssistant hasCollections={collections.length > 0} usedNames={used.map((c) => c.name)} privateConv={!!conv?.private} />
        )}
      </div>

      <AssistantComposer />

      {dragging && (
        <div className="pointer-events-none absolute inset-2 z-10 flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-accent/60 bg-bg-1/90 text-fg-1">
          <Paperclip className="size-6 text-accent" />
          <div className="font-medium">Suelta los archivos para adjuntarlos</div>
          <div className="text-small text-fg-3">Se leen en este equipo; el asistente solo puede leerlos</div>
        </div>
      )}
    </section>
  )
}

function EmptyAssistant({ hasCollections, usedNames, privateConv }: { hasCollections: boolean; usedNames: string[]; privateConv: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
      <span className="grid size-10 place-items-center rounded-lg bg-accent-soft text-accent">
        <BookOpenText className="size-5" />
      </span>
      <div className="text-title font-semibold">Asistente de oficina</div>
      <div className="max-w-md text-small text-fg-3">
        Pregunta a tus documentos, resume, redacta o traduce. Responde citando de qué documento saca cada dato y, si no lo encuentra, lo dice. Nada sale de este ordenador
        {privateConv ? '; y esta conversación privada no se guarda.' : '.'}
      </div>
      {usedNames.length > 0 && <div className="text-small text-fg-2">Buscando en: {usedNames.join(', ')}</div>}
      {!hasCollections && (
        <Button variant="secondary" icon={<FolderPlus />} onClick={() => useAssistant.getState().setNewKb(true)}>
          Crear mi primera base de conocimiento
        </Button>
      )}
      <div className="mt-2 flex max-w-xl flex-wrap justify-center gap-1.5">
        {ASSISTANT_TEMPLATES.map((t) => (
          <button
            key={t.id}
            type="button"
            title={t.hint}
            onClick={() => useAssistant.getState().setDraft(t.text)}
            className="rounded-md border border-line bg-bg-2 px-2.5 py-1 text-small text-fg-2 hover:border-line-strong hover:text-fg-1"
          >
            {t.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function CollectionsPicker() {
  const conv = useAssistant((s) => s.conversations.find((c) => c.id === s.activeId))
  const collections = useAssistant((s) => s.collections)
  if (!conv || !collections.length) return null
  const selected = collections.filter((c) => conv.collectionIds.includes(c.id))
  return (
    <button
      type="button"
      className="flex h-7 items-center gap-1.5 rounded-md border border-line-subtle px-2 text-small text-fg-2 hover:border-line"
      onClick={(e) =>
        openMenuAt(
          e.currentTarget,
          collections.map((c) => {
            const on = conv.collectionIds.includes(c.id)
            const blocked = c.confidential && !conv.private
            return {
              id: c.id,
              label: c.name,
              icon: c.confidential ? <Lock /> : <Library />,
              checked: on,
              hint: blocked ? 'Confidencial: solo en conversaciones privadas' : `${c.documents} doc.`,
              onSelect: blocked ? undefined : () => void useAssistant.getState().setCollections(on ? conv.collectionIds.filter((x) => x !== c.id) : [...conv.collectionIds, c.id]),
            }
          }),
          'end',
        )
      }
    >
      <Library className="size-3.5" />
      {selected.length === 0 ? 'Sin documentos' : selected.length === 1 ? selected[0]!.name : `${selected.length} bases`}
      <ChevronDown className="size-3" />
    </button>
  )
}

function ModelSelect() {
  const model = useAssistantModel()
  const installed = useOllama((s) => s.installed)
  const chat = installed.filter(isChatModel)
  if (!chat.length) return null
  return (
    <Select value={chat.some((m) => m.name === model) ? model : ''} onChange={(e) => useSettings.getState().set('assistantModel', e.target.value)} className="h-7 w-48 text-small" title="Modelo del asistente">
      {!chat.some((m) => m.name === model) && <option value="">{model}</option>}
      {chat.map((m) => (
        <option key={m.name} value={m.name}>
          {m.name.replace(/-it-qat$/, '')}
        </option>
      ))}
    </Select>
  )
}

function Sources({ items, live }: { items: (AssistantSource & { cited?: boolean })[]; live?: boolean }) {
  const [open, setOpen] = useState<number | null>(null)
  const ordered = useMemo(() => (live ? items : [...items].sort((a, b) => Number(!!b.cited) - Number(!!a.cited) || a.n - b.n)), [items, live])
  const shown = live ? ordered : ordered.filter((s) => s.cited)
  const rest = live ? [] : ordered.filter((s) => !s.cited)
  const [showAll, setShowAll] = useState(false)
  if (!items.length) return null
  const row = (s: AssistantSource & { cited?: boolean }) => (
    <div key={s.n} className="rounded-md border border-line-subtle bg-bg-2">
      <button type="button" onClick={() => setOpen(open === s.n ? null : s.n)} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-small">
        <span className={cn('grid h-[18px] min-w-[18px] place-items-center rounded-sm px-1 font-mono text-micro', s.cited ? 'bg-accent-soft text-accent' : 'bg-bg-3 text-fg-3')}>{s.n}</span>
        <FileText className="size-3.5 shrink-0 text-fg-3" />
        <span className="flex-1 truncate text-fg-1" title={s.relPath}>
          {s.name}
          <span className="text-fg-3">{[s.page ? ` · pág. ${s.page}` : '', s.section ? ` · ${s.section}` : ''].join('')}</span>
        </span>
        <span
          role="button"
          tabIndex={0}
          className="text-tiny text-accent hover:underline"
          onClick={(e) => {
            e.stopPropagation()
            void useAssistant.getState().openDocument(s.documentId)
          }}
        >
          Abrir
        </span>
        {open === s.n ? <ChevronDown className="size-3.5 text-fg-3" /> : <ChevronRight className="size-3.5 text-fg-3" />}
      </button>
      {open === s.n && <div className="selectable border-t border-line-subtle px-3 py-2 text-small whitespace-pre-wrap text-fg-2">{s.text}</div>}
    </div>
  )
  return (
    <div className="mt-3 flex flex-col gap-1">
      <div className="text-micro font-semibold tracking-[0.06em] text-fg-3 uppercase">{live ? 'Fragmentos encontrados' : 'Fuentes'}</div>
      {shown.map(row)}
      {!live && shown.length === 0 && <div className="text-small text-fg-3">La respuesta no cita ningún fragmento.</div>}
      {rest.length > 0 && (
        <>
          <button type="button" className="self-start text-tiny text-fg-3 hover:text-fg-1" onClick={() => setShowAll(!showAll)}>
            {showAll ? 'Ocultar' : `Ver ${rest.length} fragmento${rest.length === 1 ? '' : 's'} más consultado${rest.length === 1 ? '' : 's'}`}
          </button>
          {showAll && rest.map(row)}
        </>
      )}
    </div>
  )
}

const time = (ts: number) => new Date(ts).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })

function AssistantMessageView({ m }: { m: AssistantMessage }) {
  const blocks = m.blocks as { kind: string; text?: string; code?: string; message?: string; items?: unknown[] }[]
  if (m.role === 'user') {
    const text = blocks.find((b) => b.kind === 'text')?.text ?? ''
    const att = blocks.find((b) => b.kind === 'attachments')?.items as { id: string; name: string; ext: string; kind: string; size: number }[] | undefined
    return (
      <div className="flex flex-col items-end gap-1.5">
        {att && (
          <div className="flex flex-wrap justify-end gap-1.5">
            {att.map((a) => (
              <span key={a.id} className="flex items-center gap-1.5 rounded-md border border-line-subtle bg-bg-2 px-2 py-1 text-tiny text-fg-2">
                <Paperclip className="size-3" />
                {a.name}
              </span>
            ))}
          </div>
        )}
        <div className="selectable max-w-[85%] rounded-xl bg-bg-3 px-3.5 py-2 whitespace-pre-wrap text-fg-1">
          <RichText text={text} />
        </div>
      </div>
    )
  }
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5 text-tiny text-fg-3">
        <span className="grid size-[18px] place-items-center rounded-[5px] bg-accent-soft text-accent">
          <Sparkles className="size-3" />
        </span>
        <span className="font-medium text-fg-2">Asistente</span>
        {m.model && <span className="font-mono">· {m.model}</span>}
        <span>· {time(m.createdAt)}</span>
      </div>
      <div className="pl-3 leading-[1.65] text-fg-1">
        {blocks.map((b, i) => {
          if (b.kind === 'text') return <MarkdownView key={i} text={b.text ?? ''} />
          if (b.kind === 'sources') return <Sources key={i} items={(b.items ?? []) as (AssistantSource & { cited?: boolean })[]} />
          if (b.kind === 'notice')
            return (
              <div key={i} className="mt-2 flex items-start gap-2 text-small text-warn">
                <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
                {b.text}
              </div>
            )
          if (b.kind === 'error') return <ErrorBlock key={i} code={(b as { code?: string }).code ?? 'MODEL_ERROR'} message={b.message ?? ''} />
          return null
        })}
      </div>
    </div>
  )
}

function LiveView({ live }: { live: AssistantLive }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5 text-tiny text-fg-3">
        <Spinner size={12} />
        <span className="font-medium text-fg-2">{STATE_LABEL[live.state]}</span>
      </div>
      <div className="border-l-2 border-accent pl-3 leading-[1.65] text-fg-1">{live.text ? <MarkdownView text={live.text} /> : <div className="text-small text-fg-3">…</div>}</div>
      {live.sources && <Sources items={live.sources} live />}
      {live.sources?.length === 0 && <div className="mt-2 text-small text-fg-3">No se encontró nada relacionado en tus documentos.</div>}
    </div>
  )
}

function AssistantComposer() {
  const draft = useAssistant((s) => s.draft)
  const attachments = useAssistant((s) => s.attachments)
  const live = useAssistant((s) => (s.activeId ? s.live[s.activeId] : undefined))
  const model = useAssistantModel()
  const preview = usePreview()
  const fileRef = useRef<HTMLInputElement>(null)
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const st = useAssistant.getState()

  useEffect(() => {
    const el = areaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(220, el.scrollHeight)}px`
  }, [draft])

  const submit = async () => {
    const text = draft.trim()
    if (!text || live) return
    if (await st.send(text, model)) st.setDraft('')
  }

  return (
    <div className="shrink-0 px-4 pb-4">
      <div className="mx-auto max-w-[780px] rounded-xl border border-line bg-bg-2 focus-within:border-line-strong">
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-3">
            {attachments.map((a) => (
              <AttachmentCard key={a.id} a={a} compact onRemove={() => st.removeAttachment(a.id)} onOpen={() => preview(a)} />
            ))}
          </div>
        )}
        <textarea
          ref={areaRef}
          rows={2}
          value={draft}
          placeholder="Pregunta a tus documentos o pide un resumen, un correo, una traducción…"
          onChange={(e) => st.setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void submit()
            }
          }}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files)
            if (files.length) {
              e.preventDefault()
              st.addFiles(files)
            }
          }}
          className="block max-h-[220px] w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-body text-fg-1 outline-none placeholder:text-fg-3"
        />
        <div className="flex items-center gap-1 px-2 pb-2">
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              st.addFiles(Array.from(e.target.files ?? []))
              e.target.value = ''
            }}
          />
          <IconButton label="Adjuntar archivos (se leen en este equipo)" icon={<Paperclip />} onClick={() => fileRef.current?.click()} />
          <button
            type="button"
            className="flex h-7 items-center gap-1 rounded-md px-2 text-small text-fg-3 hover:bg-bg-3 hover:text-fg-1"
            onClick={(e) =>
              openMenuAt(
                e.currentTarget,
                ASSISTANT_TEMPLATES.map((t) => ({ id: t.id, label: t.label, hint: t.hint, onSelect: () => st.setDraft(t.text) })),
              )
            }
          >
            Plantillas <ChevronDown className="size-3" />
          </button>
          <span className="ml-auto mr-1 text-tiny text-fg-3">Revisa los importes y fechas en el original</span>
          {live ? (
            <IconButton label="Detener" icon={<Square />} onClick={() => void st.cancel()} />
          ) : (
            <Button size="sm" icon={<ArrowUp />} disabled={!draft.trim()} onClick={() => void submit()}>
              Enviar
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
