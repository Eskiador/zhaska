import type { ReactNode, SelectHTMLAttributes, InputHTMLAttributes } from 'react'
import { Check, ChevronDown, X } from 'lucide-react'
import { cn } from '@renderer/lib/cn'

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-[18px] items-center rounded-sm border border-line-strong px-1 font-mono text-micro font-medium text-fg-3',
        className,
      )}
    >
      {children}
    </kbd>
  )
}

type Tone = 'neutral' | 'accent' | 'agent' | 'ok' | 'err' | 'warn'
const tones: Record<Tone, string> = {
  neutral: 'bg-bg-3 text-fg-2',
  accent: 'bg-accent-soft text-accent',
  agent: 'bg-agent-soft text-agent',
  ok: 'bg-ok-soft text-ok',
  err: 'bg-err-soft text-err',
  warn: 'bg-warn-soft text-warn',
}

export function Badge({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex h-[18px] items-center gap-1 whitespace-nowrap rounded-sm px-1.5 text-micro font-medium [&_svg]:size-3', tones[tone], className)}>
      {children}
    </span>
  )
}

/** Anillo giratorio. `tone` agent = trabajo de la IA. */
export function Spinner({ size = 14, tone = 'agent' }: { size?: number; tone?: 'agent' | 'accent' | 'muted' }) {
  const color = tone === 'agent' ? 'var(--color-agent)' : tone === 'accent' ? 'var(--color-accent)' : 'var(--color-fg-3)'
  return (
    <span
      aria-hidden
      className="inline-block shrink-0 animate-spin rounded-full"
      style={{
        width: size,
        height: size,
        border: '1.5px solid color-mix(in srgb, ' + color + ' 22%, transparent)',
        borderTopColor: color,
        animationDuration: '800ms',
      }}
    />
  )
}

export function Dot({ className }: { className?: string }) {
  return <span className={cn('inline-block size-1.5 shrink-0 rounded-full', className)} />
}

export function Switch({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-[18px] w-8 shrink-0 rounded-full border transition-colors duration-150',
        checked ? 'border-transparent bg-accent' : 'border-line-strong bg-bg-3',
        disabled && 'opacity-45',
      )}
    >
      <span
        className={cn(
          'absolute top-[2px] left-0 size-3 rounded-full bg-white shadow transition-transform duration-150 ease-soft',
          checked ? 'translate-x-[15px]' : 'translate-x-[2px]',
        )}
      />
    </button>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { value: T; label: string; icon?: ReactNode; disabled?: boolean }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="inline-flex rounded-md border border-line bg-bg-0 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
          className={cn(
            'flex h-6 items-center gap-1.5 rounded-sm px-2.5 text-small transition-colors [&_svg]:size-3.5',
            value === o.value ? 'bg-bg-3 text-fg-1 shadow-[0_0_0_1px_var(--color-line-strong)]' : 'text-fg-2 hover:text-fg-1',
            o.disabled && 'opacity-40',
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className={cn('relative inline-flex', className)}>
      <select
        {...rest}
        className="h-7 w-full appearance-none rounded-md border border-line-strong bg-bg-2 pr-7 pl-2.5 text-small text-fg-1 outline-none hover:bg-bg-3 focus-visible:border-accent disabled:opacity-45"
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2 text-fg-3" />
    </div>
  )
}

export function TextInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...rest}
      className={cn(
        'h-7 rounded-md border border-line-strong bg-bg-2 px-2.5 text-small text-fg-1 outline-none placeholder:text-fg-3 focus-visible:border-accent disabled:opacity-50',
        className,
      )}
    />
  )
}

export function Slider({
  value,
  min,
  max,
  step,
  onChange,
}: {
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
}) {
  const pct = ((value - min) / (max - min)) * 100
  return (
    <input
      type="range"
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={(e) => onChange(Number(e.target.value))}
      className="h-1 w-40 cursor-pointer appearance-none rounded-full bg-bg-4 accent-accent [&::-webkit-slider-thumb]:size-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow"
      style={{ background: `linear-gradient(90deg, var(--color-accent) ${pct}%, var(--color-bg-4) ${pct}%)` }}
    />
  )
}

/** Icono de estado de un paso (DESIGN.md §4). */
export function StatusIcon({ status }: { status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' }) {
  if (status === 'running') return <Spinner size={14} />
  if (status === 'completed')
    return (
      <span className="grid size-3.5 place-items-center rounded-full bg-ok-soft text-ok">
        <Check className="size-2.5" strokeWidth={3} />
      </span>
    )
  if (status === 'failed')
    return (
      <span className="grid size-3.5 place-items-center rounded-full bg-err-soft text-err">
        <X className="size-2.5" strokeWidth={3} />
      </span>
    )
  if (status === 'cancelled')
    return <span className="grid size-3.5 place-items-center rounded-full border-[1.5px] border-fg-3/50 after:block after:h-[1.5px] after:w-1.5 after:bg-fg-3/70" />
  return <span className="size-3.5 rounded-full border-[1.5px] border-line-strong" />
}

export function EmptyState({
  icon,
  title,
  description,
  children,
  className,
}: {
  icon?: ReactNode
  title: string
  description?: ReactNode
  children?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 px-6 py-10 text-center', className)}>
      {icon && <div className="mb-1 grid size-9 place-items-center rounded-lg border border-line bg-bg-2 text-fg-3 [&_svg]:size-[18px]">{icon}</div>}
      <div className="font-medium text-fg-1">{title}</div>
      {description && <div className="max-w-72 text-small text-fg-3">{description}</div>}
      {children && <div className="mt-2 flex flex-wrap items-center justify-center gap-2">{children}</div>}
    </div>
  )
}

export function SectionLabel({ children, right, className }: { children: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex h-7 items-center justify-between px-3 text-micro font-semibold tracking-[0.07em] text-fg-3 uppercase', className)}>
      <span>{children}</span>
      {right}
    </div>
  )
}
