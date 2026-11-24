import { cloneElement, useLayoutEffect, useRef, useState, type FocusEvent, type MouseEvent, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

type Side = 'top' | 'bottom' | 'left' | 'right'

interface Props {
  content: ReactNode
  children: ReactElement<Record<string, unknown>>
  side?: Side
  delay?: number
}

/** Tooltip en portal (no lo recortan los paneles con overflow). El hijo debe aceptar eventos de ratón y foco. */
export function Tooltip({ content, children, side = 'bottom', delay = 450 }: Props) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const tipRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  const show = (el: HTMLElement) => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setAnchor(el.getBoundingClientRect()), delay)
  }
  const hide = () => {
    window.clearTimeout(timer.current)
    setAnchor(null)
    setPos(null)
  }

  useLayoutEffect(() => {
    if (!anchor || !tipRef.current) return
    const t = tipRef.current.getBoundingClientRect()
    const gap = 6
    let left = anchor.left + anchor.width / 2 - t.width / 2
    let top = anchor.bottom + gap
    if (side === 'top') top = anchor.top - t.height - gap
    if (side === 'left') {
      left = anchor.left - t.width - gap
      top = anchor.top + anchor.height / 2 - t.height / 2
    }
    if (side === 'right') {
      left = anchor.right + gap
      top = anchor.top + anchor.height / 2 - t.height / 2
    }
    left = Math.max(8, Math.min(left, window.innerWidth - t.width - 8))
    top = Math.max(8, Math.min(top, window.innerHeight - t.height - 8))
    setPos({ left, top })
  }, [anchor, side])

  if (!content) return children

  const child = cloneElement(children, {
    onMouseEnter: (e: MouseEvent<HTMLElement>) => show(e.currentTarget),
    onMouseLeave: hide,
    onFocus: (e: FocusEvent<HTMLElement>) => show(e.currentTarget),
    onBlur: hide,
    onMouseDown: hide,
  })

  return (
    <>
      {child}
      {anchor &&
        createPortal(
          <div
            ref={tipRef}
            role="tooltip"
            style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
            className="pointer-events-none fixed z-[100] max-w-72 animate-fade-in rounded-md border border-line-strong bg-bg-3 px-2 py-1 text-small text-fg-1 shadow-pop"
          >
            {content}
          </div>,
          document.body,
        )}
    </>
  )
}
