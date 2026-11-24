/**
 * ⚠️ DATOS SIMULADOS (Fase 2).
 * Proyecto de demostración para visualizar la interfaz. Desde la Fase 3 el explorador y el editor
 * leen el sistema de archivos real a través del IPC.
 */

export interface DemoFile {
  path: string
  content: string
  /** Contenido antes de los cambios del agente (solo archivos que el agente tocó). */
  original?: string
  changedBy?: 'agent' | 'user'
}

const pkgOriginal = `{
  "name": "tienda-analytics",
  "version": "0.3.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "react": "^19.3.1",
    "react-dom": "^19.3.1"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^6.3.0",
    "typescript": "^7.0.2",
    "vite": "^8.3.8",
    "vitest": "^4.0.0"
  }
}
`

const pkgModified = pkgOriginal.replace(
  `"react-dom": "^19.3.1"`,
  `"react-dom": "^19.3.1",
    "recharts": "^3.2.0"`,
)

const dashboardOriginal = `import { useState } from 'react'
import { Header } from './Header'

type Range = '3m' | '6m' | '12m'

export function Dashboard() {
  const [range, setRange] = useState<Range>('12m')

  return (
    <main className="dashboard">
      <Header title="Ventas" />
      <p className="empty">Aún no hay gráficos.</p>
    </main>
  )
}
`

const dashboardModified = `import { useMemo, useState } from 'react'
import { Header } from './Header'
import { SalesChart } from './SalesChart'
import { RangePicker } from './RangePicker'
import { ventas } from '../data/ventas'
import { byMonth, type Range } from '../hooks/useSales'

export function Dashboard() {
  const [range, setRange] = useState<Range>('12m')
  const data = useMemo(() => byMonth(ventas, range), [range])
  const total = data.reduce((acc, m) => acc + m.total, 0)

  return (
    <main className="dashboard">
      <Header title="Ventas" subtitle={\`\${total.toLocaleString('es-ES')} € en el periodo\`} />
      <section className="card">
        <div className="card-header">
          <h2>Ventas mensuales por categoría</h2>
          <RangePicker value={range} onChange={setRange} />
        </div>
        <SalesChart data={data} />
      </section>
    </main>
  )
}
`

const salesChart = `import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { MonthTotals } from '../hooks/useSales'

interface Props {
  data: MonthTotals[]
}

const SERIES = [
  { key: 'electronica', label: 'Electrónica', color: '#4F7DFF' },
  { key: 'hogar', label: 'Hogar', color: '#9381FF' },
  { key: 'moda', label: 'Moda', color: '#3DBE84' },
  { key: 'deporte', label: 'Deporte', color: '#E7B55B' },
] as const

export function SalesChart({ data }: Props) {
  return (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#2C3342" />
        <XAxis dataKey="mes" tickLine={false} axisLine={false} />
        <YAxis tickLine={false} axisLine={false} />
        <Tooltip cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
        <Legend />
        {SERIES.map((s) => (
          <Bar key={s.key} dataKey={s.key} name={s.label} stackId="ventas" fill={s.color} radius={[2, 2, 0, 0]} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  )
}
`

const appOriginal = `import { Dashboard } from './components/Dashboard'
import './styles.css'

export default function App() {
  return <Dashboard />
}
`

const appModified = `import { StrictMode } from 'react'
import { Dashboard } from './components/Dashboard'
import './styles.css'

export default function App() {
  return (
    <StrictMode>
      <div className="app-shell">
        <Dashboard />
      </div>
    </StrictMode>
  )
}
`

export const DEMO_FILES: DemoFile[] = [
  { path: 'index.html', content: `<!doctype html>\n<html lang="es">\n  <head>\n    <meta charset="UTF-8" />\n    <title>Tienda · Analítica</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.tsx"></script>\n  </body>\n</html>\n` },
  { path: 'package.json', content: pkgModified, original: pkgOriginal, changedBy: 'agent' },
  { path: 'README.md', content: `# tienda-analytics\n\nPanel interno de ventas de la tienda.\n\n## Scripts\n\n- \`npm run dev\` — servidor de desarrollo\n- \`npm test\` — pruebas\n` },
  { path: 'tsconfig.json', content: `{\n  "compilerOptions": {\n    "target": "ES2022",\n    "jsx": "react-jsx",\n    "module": "ESNext",\n    "moduleResolution": "bundler",\n    "strict": true\n  },\n  "include": ["src"]\n}\n` },
  { path: 'vite.config.ts', content: `import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\n\nexport default defineConfig({\n  plugins: [react()],\n})\n` },
  { path: 'public/favicon.svg', content: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="4" fill="#4F7DFF"/></svg>\n` },
  { path: 'src/main.tsx', content: `import { createRoot } from 'react-dom/client'\nimport App from './App'\n\ncreateRoot(document.getElementById('root')!).render(<App />)\n` },
  { path: 'src/App.tsx', content: appModified, original: appOriginal, changedBy: 'agent' },
  { path: 'src/styles.css', content: `:root {\n  color-scheme: dark;\n  font-family: Inter, system-ui, sans-serif;\n}\n\n.dashboard {\n  display: grid;\n  gap: 24px;\n  padding: 32px;\n}\n\n.card {\n  border: 1px solid #2c3342;\n  border-radius: 10px;\n  padding: 20px;\n}\n` },
  { path: 'src/components/Header.tsx', content: `interface Props {\n  title: string\n  subtitle?: string\n}\n\nexport function Header({ title, subtitle }: Props) {\n  return (\n    <header className="header">\n      <h1>{title}</h1>\n      {subtitle && <p className="subtitle">{subtitle}</p>}\n    </header>\n  )\n}\n` },
  { path: 'src/components/Dashboard.tsx', content: dashboardModified, original: dashboardOriginal, changedBy: 'agent' },
  { path: 'src/components/SalesChart.tsx', content: salesChart, original: '', changedBy: 'agent' },
  { path: 'src/components/RangePicker.tsx', content: `import type { Range } from '../hooks/useSales'\n\nconst OPTIONS: Range[] = ['3m', '6m', '12m']\n\nexport function RangePicker({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {\n  return (\n    <div className="range-picker" role="tablist">\n      {OPTIONS.map((o) => (\n        <button key={o} role="tab" aria-selected={o === value} onClick={() => onChange(o)}>\n          {o}\n        </button>\n      ))}\n    </div>\n  )\n}\n` },
  { path: 'src/hooks/useSales.ts', content: `import type { Venta } from '../data/ventas'\n\nexport type Range = '3m' | '6m' | '12m'\n\nexport interface MonthTotals {\n  mes: string\n  electronica: number\n  hogar: number\n  moda: number\n  deporte: number\n  total: number\n}\n\nconst MONTHS = { '3m': 3, '6m': 6, '12m': 12 } as const\n\nexport function byMonth(rows: Venta[], range: Range): MonthTotals[] {\n  const map = new Map<string, MonthTotals>()\n  for (const r of rows) {\n    const m = map.get(r.mes) ?? { mes: r.mes, electronica: 0, hogar: 0, moda: 0, deporte: 0, total: 0 }\n    m[r.categoria] += r.importe\n    m.total += r.importe\n    map.set(r.mes, m)\n  }\n  return [...map.values()].slice(-MONTHS[range])\n}\n` },
  { path: 'src/data/ventas.ts', content: `export interface Venta {\n  mes: string\n  categoria: 'electronica' | 'hogar' | 'moda' | 'deporte'\n  importe: number\n}\n\n// Generado a partir de ventas_2026.xlsx (hoja "Resumen")\nexport const ventas: Venta[] = [\n  { mes: 'ene', categoria: 'electronica', importe: 18420 },\n  { mes: 'ene', categoria: 'hogar', importe: 9310 },\n  { mes: 'ene', categoria: 'moda', importe: 12880 },\n  { mes: 'ene', categoria: 'deporte', importe: 6140 },\n  // …\n]\n` },
]

export const DEMO_PROJECT = {
  id: 'demo-tienda',
  name: 'tienda-analytics',
  root: 'C:\\Users\\demo\\proyectos\\tienda-analytics',
  branch: 'main',
}

export const DEMO_RECENT_PROJECTS = [
  { id: 'demo-tienda', name: 'tienda-analytics', when: 'ahora' },
  { id: 'demo-portfolio', name: 'portfolio-web', when: '3 d' },
  { id: 'demo-scraper', name: 'scraper-precios', when: '1 sem' },
]

export interface TreeNode {
  name: string
  path: string
  kind: 'dir' | 'file'
  children?: TreeNode[]
}

export function buildTree(files: { path: string }[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', kind: 'dir', children: [] }
  for (const f of files) {
    const parts = f.path.split('/')
    let node = root
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join('/')
      const isFile = i === parts.length - 1
      let child = node.children!.find((c) => c.name === part)
      if (!child) {
        child = { name: part, path, kind: isFile ? 'file' : 'dir', children: isFile ? undefined : [] }
        node.children!.push(child)
      }
      node = child
    })
  }
  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1))
    nodes.forEach((n) => n.children && sort(n.children))
  }
  sort(root.children!)
  return root.children!
}
