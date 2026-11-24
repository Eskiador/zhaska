import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { CircleCheck, CircleX, Info, Lock, X } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { lockedHint } from '@renderer/lib/phases'
import { useUI, notifyLocked, type MenuItem, type MenuState } from '@renderer/stores/ui'

/* ───────────────────────────── Menús (desplegables y contextuales) ───────────────────────────── */

/** Abre un menú anclado bajo un elemento. */
export function openMenuAt(el: HTMLElement, items: MenuItem[], align: 'start' | 'end' = 'start') {
  const r = el.getBoundingClientRect()
  useUI.getState().openMenu({ items, x: align === 'start' ? r.left : r.right, y: r.bottom + 4, minWidth: align === 'start' ? r.width : undefined })
}

/** Abre un menú contextual en la posición del ratón. */
export function openContextMenu(e: { clientX: number; clientY: number; preventDefault: () => void }, items: MenuItem[]) {
  e.preventDefault()
  useUI.getState().openMenu({ items, x: e.clientX, y: e.clientY })
}

export function MenuHost() {
  const menu = useUI((s) => s.menu)
  const close = useUI((s) => s.closeMenu)
  if (!menu) return null
  return <MenuView key={`${menu.x}-${menu.y}`} menu={menu} onClose={close} />
}

function MenuView({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: menu.x, top: menu.y })
  const [active, setActive] = useState(-1)
  const selectable = menu.items.map((it, i) => (it.separator ? -1 : i)).filter((i) => i >= 0)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      left: Math.max(8, Math.min(menu.x, window.innerWidth - r.width - 8)),
      top: menu.y + r.height > window.innerHeight - 8 ? Math.max(8, menu.y - r.height - 8) : menu.y,
    })
    el.focus()
  }, [menu])

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onBlur = () => onClose()
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('blur', onBlur)
    window.addEventListener('resize', onBlur)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('resize', onBlur)
    }
  }, [onClose])

  const run = (it: MenuItem) => {
    onClose()
    if (it.lockedPhase) return notifyLocked(it.lockedPhase, it.label ?? 'Esta acción')
    it.onSelect?.()
  }

  return createPortal(
    <div
      ref={ref}
      role="menu"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          const idx = selectable.indexOf(active)
          const next = e.key === 'ArrowDown' ? (idx + 1) % selectable.length : (idx - 1 + selectable.length) % selectable.length
          setActive(selectable[next] ?? -1)
        }
        if (e.key === 'Enter' && active >= 0) run(menu.items[active]!)
      }}
      style={{ left: pos.left, top: pos.top, minWidth: Math.max(menu.minWidth ?? 0, 200) }}
      className="fixed z-[90] animate-pop-in rounded-xl border border-line bg-bg-2 p-1 shadow-pop outline-none"
    >
      {menu.items.map((it, i) =>
        it.separator ? (
          <div key={it.id} className="mx-1 my-1 h-px bg-line" />
        ) : (
          <button
            key={it.id}
            role="menuitem"
            type="button"
            title={it.lockedPhase ? lockedHint(it.lockedPhase) : it.hint}
            onMouseEnter={() => setActive(i)}
            onClick={() => run(it)}
            className={cn(
              'flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px] [&>svg]:size-3.5 [&>svg]:shrink-0',
              active === i ? 'bg-bg-3 text-fg-1' : 'text-fg-2',
              it.danger && 'text-err',
              it.lockedPhase && 'opacity-50',
            )}
          >
            {it.icon ?? <span className="w-3.5" />}
            <span className="flex-1 truncate">{it.label}</span>
            {it.checked && <span className="size-1.5 rounded-full bg-accent" />}
            {it.lockedPhase ? <Lock className="!size-3" /> : it.shortcut && <span className="font-mono text-micro text-fg-3">{it.shortcut}</span>}
          </button>
        ),
      )}
    </div>,
    document.body,
  )
}

/* ───────────────────────────── Diálogos ───────────────────────────── */

export function Dialog({
  open,
  onClose,
  title,
  icon,
  width = 720,
  children,
  footer,
  bare,
}: {
  open: boolean
  onClose: () => void
  title?: ReactNode
  icon?: ReactNode
  width?: number
  children: ReactNode
  footer?: ReactNode
  /** Sin cabecera ni padding (paleta de comandos, ajustes). */
  bare?: boolean
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return createPortal(
    <div className="fixed inset-0 z-[80] flex animate-fade-in items-start justify-center bg-black/55 pt-[9vh] backdrop-blur-[2px]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        role="dialog"
        aria-modal
        style={{ width }}
        className="flex max-h-[80vh] max-w-[calc(100vw-48px)] animate-pop-in flex-col overflow-hidden rounded-2xl border border-line bg-bg-1 shadow-pop"
      >
        {!bare && (
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-4">
            {icon && <span className="text-fg-2 [&_svg]:size-4">{icon}</span>}
            <span className="text-body font-semibold">{title}</span>
            <button type="button" aria-label="Cerrar" onClick={onClose} className="ml-auto grid size-6 place-items-center rounded-sm text-fg-3 hover:bg-bg-3 hover:text-fg-1">
              <X className="size-4" />
            </button>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
        {footer && <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-4 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}

/* ───────────────────────────── Notificaciones ───────────────────────────── */

export function Toaster() {
  const toasts = useUI((s) => s.toasts)
  const dismiss = useUI((s) => s.dismissToast)
  return createPortal(
    <div className="pointer-events-none fixed right-4 bottom-9 z-[95] flex w-80 flex-col gap-2" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="pointer-events-auto flex animate-toast-in gap-2.5 rounded-lg border border-line-strong bg-bg-2 p-3 shadow-pop">
          <span className="mt-0.5 [&_svg]:size-4">
            {t.tone === 'success' && <CircleCheck className="text-ok" />}
            {t.tone === 'error' && <CircleX className="text-err" />}
            {t.tone === 'info' && <Info className="text-accent" />}
            {t.tone === 'locked' && <Lock className="text-warn" />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-medium text-fg-1">{t.title}</div>
            {t.description && <div className="mt-0.5 text-small text-fg-3">{t.description}</div>}
          </div>
          <button type="button" aria-label="Cerrar" onClick={() => dismiss(t.id)} className="grid size-5 place-items-center rounded-sm text-fg-3 hover:bg-bg-3 hover:text-fg-1">
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>,
    document.body,
  )
}
