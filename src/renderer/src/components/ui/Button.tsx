import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Lock } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { lockedHint } from '@renderer/lib/phases'
import { notifyLocked } from '@renderer/stores/ui'
import { Tooltip } from './Tooltip'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'agent'
type Size = 'sm' | 'md'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  icon?: ReactNode
  /** Función que llega en una fase futura: se muestra deshabilitada con candado y explicación. */
  lockedPhase?: number
  tooltip?: ReactNode
}

const variants: Record<Variant, string> = {
  primary: 'bg-accent-solid text-white hover:bg-accent-hover border-transparent',
  secondary: 'bg-bg-2 text-fg-1 border-line-strong hover:bg-bg-3',
  ghost: 'bg-transparent text-fg-2 border-transparent hover:bg-bg-3 hover:text-fg-1',
  danger: 'bg-err-soft text-err border-transparent hover:bg-err/20',
  agent: 'bg-agent-soft text-agent border-transparent hover:bg-agent/20',
}

const sizes: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-small gap-1.5 [&_svg]:size-3.5',
  md: 'h-8 px-3 text-body gap-1.5 [&_svg]:size-[15px]',
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, lockedPhase, tooltip, className, children, onClick, ...rest },
  ref,
) {
  const locked = lockedPhase !== undefined
  const btn = (
    <button
      ref={ref}
      type="button"
      aria-disabled={locked || rest.disabled || undefined}
      className={cn(
        'inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-md border font-medium transition-colors duration-100 select-none',
        variants[variant],
        sizes[size],
        (locked || rest.disabled) && 'pointer-events-auto opacity-45 hover:bg-inherit',
        className,
      )}
      onClick={(e) => {
        if (locked) {
          e.preventDefault()
          notifyLocked(lockedPhase, typeof children === 'string' ? children : 'Esta acción')
          return
        }
        onClick?.(e)
      }}
      {...rest}
    >
      {icon}
      {children}
      {locked && <Lock className="!size-3 opacity-70" />}
    </button>
  )
  const tip = locked ? lockedHint(lockedPhase) : tooltip
  return tip ? <Tooltip content={tip}>{btn}</Tooltip> : btn
})

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  label: string
  icon: ReactNode
  active?: boolean
  lockedPhase?: number
  shortcut?: string
  side?: 'top' | 'bottom' | 'left' | 'right'
  size?: 'sm' | 'md'
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, active, lockedPhase, shortcut, side, size = 'md', className, onClick, ...rest },
  ref,
) {
  const locked = lockedPhase !== undefined
  return (
    <Tooltip
      side={side}
      content={
        <span className="flex items-center gap-2">
          {locked ? lockedHint(lockedPhase) : label}
          {shortcut && !locked && <span className="font-mono text-micro text-fg-3">{shortcut}</span>}
        </span>
      }
    >
      <button
        ref={ref}
        type="button"
        aria-label={label}
        aria-pressed={active}
        aria-disabled={locked || undefined}
        className={cn(
          'grid shrink-0 place-items-center rounded-sm text-fg-2 transition-colors duration-100 hover:bg-bg-3 hover:text-fg-1',
          size === 'md' ? 'size-6 [&_svg]:size-[15px]' : 'size-5 [&_svg]:size-3.5',
          active && 'bg-bg-3 text-fg-1',
          locked && 'opacity-40',
          className,
        )}
        onClick={(e) => {
          if (locked) return notifyLocked(lockedPhase, label)
          onClick?.(e)
        }}
        {...rest}
      >
        {icon}
      </button>
    </Tooltip>
  )
})
