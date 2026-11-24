import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PathGuard } from '../../src/core/security/pathGuard'
import { FileIndex, scorePath } from '../../src/core/workspace/fileIndex'
import { searchCode } from '../../src/agent/workspace/explore'

function project(files: string[]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'zh-idx-')))
  for (const f of files) {
    mkdirSync(join(root, ...f.split('/').slice(0, -1)), { recursive: true })
    writeFileSync(join(root, ...f.split('/')), 'x')
  }
  return root
}

describe('índice de archivos («Buscar archivo»)', () => {
  it('indexa todo el proyecto salvo dependencias y compilados, sin seguir enlaces', async () => {
    const root = project(['src/app.ts', 'src/componentes/Boton.tsx', 'node_modules/react/index.js', '.git/HEAD', 'dist/app.js', 'README.md'])
    const fuera = realpathSync(mkdtempSync(join(tmpdir(), 'zh-idx-fuera-')))
    writeFileSync(join(fuera, 'secreto.txt'), 'x')
    symlinkSync(fuera, join(root, 'atajo'))
    const idx = new FileIndex(new PathGuard(root))
    await idx.ensure()
    expect([...idx.search('a', 50)].sort()).toEqual(['README.md', 'src/app.ts', 'src/componentes/Boton.tsx'].filter((f) => /a/i.test(f)).sort())
    expect(idx.size).toBe(3)
    expect(idx.search('secreto')).toEqual([])
  })

  it('ordena por nombre de archivo, inicios de palabra y letras seguidas', () => {
    expect(scorePath('boton', 'src/componentes/boton.tsx')).toBeGreaterThan(scorePath('boton', 'src/boton-viejo/indice.ts'))
    expect(scorePath('app', 'src/app.ts')).toBeGreaterThan(scorePath('app', 'src/apps/mapa.ts'))
    expect(scorePath('cbt', 'src/componentes/Boton.tsx')).toBeGreaterThan(0)
    expect(scorePath('zzz', 'src/app.ts')).toBe(0)
  })

  it('se mantiene al día con los cambios sin volver a recorrer todo', async () => {
    const root = project(['src/a.ts', 'src/viejo/b.ts', 'src/viejo/c.ts'])
    const idx = new FileIndex(new PathGuard(root))
    await idx.ensure()
    writeFileSync(join(root, 'src', 'nuevo.ts'), 'x')
    rmSync(join(root, 'src', 'viejo'), { recursive: true })
    mkdirSync(join(root, 'lib', 'interno'), { recursive: true })
    writeFileSync(join(root, 'lib', 'interno', 'd.ts'), 'x')
    await idx.update(['src/nuevo.ts', 'src/viejo', 'lib'])
    expect([...idx.search('.ts', 50)].sort()).toEqual(['lib/interno/d.ts', 'src/a.ts', 'src/nuevo.ts'])
  })

  it('50 000 rutas: construir y buscar en tiempos de interfaz', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'zh-idx-grande-')))
    for (let a = 0; a < 50; a++) {
      const dir = join(root, 'src', `m${a}`)
      mkdirSync(dir, { recursive: true })
      for (let c = 0; c < 1000; c++) writeFileSync(join(dir, `archivo${c}.ts`), '')
    }
    writeFileSync(join(root, 'src', 'm7', 'facturacion.ts'), '')
    const idx = new FileIndex(new PathGuard(root))
    let t = performance.now()
    await idx.ensure()
    const build = performance.now() - t
    t = performance.now()
    const r = idx.search('facturacion', 10)
    const search = performance.now() - t
    expect(idx.size).toBe(50_001)
    expect(r[0]).toBe('src/m7/facturacion.ts')
    expect(build).toBeLessThan(5000)
    expect(search).toBeLessThan(300)
    // La búsqueda en el contenido del agente recorre los 50 000 archivos (antes se cortaba a los 5 000)
    writeFileSync(join(root, 'src', 'm49', 'zz.ts'), 'export const AGUJA = 1\n')
    t = performance.now()
    // Sin el tope de tiempo de la herramienta (8 s): aquí se comprueba que recorre todo; el tiempo se mide aparte
    const code = await searchCode(new PathGuard(root), 'AGUJA', { regex: false, caseSensitive: false, maxResults: 80, timeBudgetMs: 120_000 })
    const scan = performance.now() - t
    console.log(`50 000 archivos: índice ${Math.round(build)} ms, buscar nombre ${Math.round(search)} ms, buscar contenido ${Math.round(scan)} ms`)
    expect(code.hits.map((h) => h.file)).toEqual(['src/m49/zz.ts'])
    expect(code.truncated).toBe(false)
    expect(code.filesScanned).toBe(50_002)
    // Las máquinas de GitHub con Windows (disco de red + antivirus) son mucho más lentas que un PC normal: allí
    // solo se registra el tiempo; en local debe caber en el tope de la herramienta
    if (!process.env['CI']) expect(scan).toBeLessThan(8000)
    rmSync(root, { recursive: true, force: true })
  }, 180_000)
})
