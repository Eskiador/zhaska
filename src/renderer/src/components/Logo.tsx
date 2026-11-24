/** Marca ZHASKA: una "Z" de trazo continuo dentro de un cuadrado cobalto. */
export function LogoMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className="shrink-0">
      <defs>
        <linearGradient id="zh-g" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#6A90FF" />
          <stop offset="1" stopColor="#3B5BDB" />
        </linearGradient>
      </defs>
      <rect x="0.5" y="0.5" width="23" height="23" rx="6" fill="url(#zh-g)" />
      <rect x="0.5" y="0.5" width="23" height="23" rx="6" fill="none" stroke="white" strokeOpacity=".14" />
      <path d="M7.5 7.5h9l-9 9h9" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="16.5" cy="16.5" r="1.6" fill="#C9BFFF" />
    </svg>
  )
}

export function Wordmark({ className }: { className?: string }) {
  return <span className={`font-semibold tracking-[0.18em] ${className ?? ''}`}>ZHASKA</span>
}
