import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PathGuard } from '../../src/core/security/pathGuard'
import { FileService } from '../../src/core/workspace/fileService'
import { validateProjectName } from '../../src/main/services/projects'

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'zh-fs-'))
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, 'node_modules'))
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1\r\n')
  writeFileSync(join(root, 'bom.txt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hola')]))
  writeFileSync(join(root, 'img.bin'), Buffer.from([1, 2, 0, 3]))
  writeFileSync(join(root, '.DS_Store'), 'x')
  const trashed: string[] = []
  const svc = new FileService(new PathGuard(root), { trash: async (p) => void trashed.push(p), reveal: () => {} })
  return { root, svc, trashed }
}

describe('FileService', () => {
  it('lista carpetas primero, marca ignoradas y oculta archivos de sistema', async () => {
    const { svc } = setup()
    const list = await svc.list('')
    expect(list.map((e) => e.name)).toEqual(['node_modules', 'src', 'bom.txt', 'img.bin'])
    expect(list.find((e) => e.name === 'node_modules')?.ignored).toBe(true)
  })

  it('detecta EOL, BOM y binarios', async () => {
    const { svc } = setup()
    expect(await svc.read('src/a.ts')).toMatchObject({ eol: 'CRLF', encoding: 'utf8', unsupported: null })
    expect(await svc.read('bom.txt')).toMatchObject({ content: 'hola', encoding: 'utf8-bom' })
    expect(await svc.read('img.bin')).toMatchObject({ unsupported: 'binary', content: '' })
  })

  it('escribe de forma atómica conservando el BOM', async () => {
    const { svc, root } = setup()
    const f = await svc.read('bom.txt')
    await svc.write('bom.txt', 'adiós', 'utf8-bom', f.mtimeMs)
    const raw = readFileSync(join(root, 'bom.txt'))
    expect([...raw.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(raw.subarray(3).toString('utf8')).toBe('adiós')
  })

  it('detecta conflictos si el archivo cambió en disco', async () => {
    const { svc, root } = setup()
    const f = await svc.read('src/a.ts')
    utimesSync(join(root, 'src', 'a.ts'), new Date(), new Date(Date.now() + 60_000))
    await expect(svc.write('src/a.ts', 'x', 'utf8', f.mtimeMs)).rejects.toThrowError(/ha cambiado en disco/)
  })

  it('crea, renombra y manda a la papelera sin salir del proyecto', async () => {
    const { svc, root, trashed } = setup()
    await svc.create('src/nuevo/b.ts', 'file')
    await expect(svc.create('src/nuevo/b.ts', 'file')).rejects.toThrowError(/ya existe/)
    await svc.rename('src/nuevo/b.ts', 'src/nuevo/c.ts')
    expect(existsSync(join(root, 'src', 'nuevo', 'c.ts'))).toBe(true)
    await svc.trash('src/nuevo/c.ts')
    expect(trashed).toEqual([join(root, 'src', 'nuevo', 'c.ts')])
    await expect(svc.trash('')).rejects.toThrowError(/raíz/)
    await expect(svc.read('../fuera.txt')).rejects.toThrowError()
  })
})

describe('validateProjectName', () => {
  it.each(['mi-app', 'Panel ventas', 'app_2'])('acepta %s', (n) => expect(validateProjectName(n)).toBe(n))
  it.each(['', '  ', '..', 'a/b', 'a\\b', 'con', 'NUL.txt', 'fin.', 'a:b'])('rechaza "%s"', (n) => expect(() => validateProjectName(n)).toThrowError())
})
