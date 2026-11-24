import { existsSync, mkdtempSync, realpathSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrate, openDatabase } from '../../src/main/db/database'
import { ProjectsRepo } from '../../src/main/db/repos'
import { ProjectService } from '../../src/main/services/projects'
import { TerminalService } from '../../src/main/services/terminals'

/** Plantillas y clonado reales (necesitan Internet, npm y Git): ZHASKA_EVAL_TEMPLATES=1 */
describe.skipIf(process.env['ZHASKA_EVAL_TEMPLATES'] !== '1')('plantillas y clonado reales', () => {
  const setup = () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'zh-tpl-')))
    const db = openDatabase(join(dir, 'z.db'))
    migrate(db)
    return { dir, svc: new ProjectService(new ProjectsRepo(db)) }
  }

  it('crea un proyecto React + Vite con Git y ZHASKA.md', async () => {
    const { dir, svc } = setup()
    const lines: string[] = []
    const p = await svc.createFromTemplate({ name: 'mi-panel', parentDir: join(dir, 'proyectos'), template: 'react-vite', gitInit: true, createGuide: true, description: 'Panel de prueba', install: false }, (l) => lines.push(l))
    console.log(lines.slice(0, 4).join('\n'))
    expect(existsSync(join(p.rootPath, 'package.json'))).toBe(true)
    expect(existsSync(join(p.rootPath, 'ZHASKA.md'))).toBe(true)
    expect(p.isGit).toBe(true)
    expect(p.warnings).toEqual([])
  })

  it('rechaza nombres no válidos para plantillas', async () => {
    const { dir, svc } = setup()
    await expect(svc.createFromTemplate({ name: 'Mi Panel', parentDir: dir, template: 'next', gitInit: false, createGuide: false, install: false }, () => {})).rejects.toThrow(/minúsculas/)
  })

  it('clona un repositorio público', async () => {
    const { dir, svc } = setup()
    const p = await svc.clone({ url: 'https://github.com/octocat/Hello-World.git', parentDir: dir }, () => {})
    expect(p.name).toBe('Hello-World')
    expect(existsSync(join(p.rootPath, 'README'))).toBe(true)
    await expect(svc.clone({ url: 'file:///etc', parentDir: dir }, () => {})).rejects.toThrow(/no válida/)
  })

  it('«npm run dev» de un proyecto React + Vite funciona dentro de la terminal', async () => {
    const { dir, svc } = setup()
    const p = await svc.createFromTemplate({ name: 'mi-web', parentDir: dir, template: 'react-vite', gitInit: false, createGuide: false, install: true }, () => {})
    expect(p.warnings).toEqual([])
    let out = ''
    const plain = () => out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '') // sin códigos de color
    const terms = new TerminalService((channel, payload) => {
      if (channel === 'terminal.data') out += (payload as { data: string }).data
    })
    const port = await new Promise<number>((resolve) => {
      const srv = createServer().listen(0, () => {
        const { port } = srv.address() as { port: number }
        srv.close(() => resolve(port))
      })
    })
    const t = terms.create('p', p.rootPath, 'powershell', 120, 30)
    await new Promise((r) => setTimeout(r, 1000))
    terms.write(t.id, `npm run dev -- --port ${port} --strictPort\r`)
    for (let i = 0; i < 300 && !plain().includes(`localhost:${port}`); i++) await new Promise((r) => setTimeout(r, 100))
    expect(plain()).toContain(`localhost:${port}`)
    const html = await (await fetch(`http://localhost:${port}/`)).text()
    expect(html).toContain('<div id="root">')
    terms.write(t.id, '\x03') // Ctrl+C detiene el servidor
    terms.dispose()
  }, 300_000)
})

