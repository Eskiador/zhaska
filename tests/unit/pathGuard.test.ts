import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PathGuard } from '../../src/core/security/pathGuard'

const noReal = () => {
  throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
}

describe('PathGuard (POSIX)', () => {
  const g = new PathGuard('/home/u/proyecto', { platform: 'linux', realpath: noReal })

  it('resuelve rutas relativas dentro del proyecto', () => {
    expect(g.resolve('src/App.tsx')).toBe('/home/u/proyecto/src/App.tsx')
    expect(g.resolve('')).toBe('/home/u/proyecto')
    expect(g.resolve('./src//components/')).toBe('/home/u/proyecto/src/components')
    expect(g.resolve('src\\App.tsx')).toBe('/home/u/proyecto/src/App.tsx')
  })

  it.each(['../secreto', 'src/../../x', '/etc/passwd', '//server/share', 'C:/Windows', 'a\0b'])('rechaza %s', (p) => {
    expect(() => g.resolve(p)).toThrowError()
  })

  it('normaliza rutas relativas', () => {
    expect(g.normalizeRel('./a/./b/')).toBe('a/b')
    expect(g.toRel('/home/u/proyecto/src/x.ts')).toBe('src/x.ts')
    expect(g.toRel('/home/u/otro/x.ts')).toBeNull()
  })

  it('no confunde prefijos de carpeta hermanas', () => {
    expect(g.isInside('/home/u/proyecto-2/x', '/home/u/proyecto')).toBe(false)
  })
})

describe('PathGuard (Windows)', () => {
  const g = new PathGuard('C:\\Users\\Ana\\proyecto', { platform: 'win32', realpath: noReal })

  it('resuelve con separadores de Windows', () => {
    expect(g.resolve('src/App.tsx')).toBe('C:\\Users\\Ana\\proyecto\\src\\App.tsx')
  })

  it('compara sin distinguir mayúsculas', () => {
    expect(g.isInside('c:\\users\\ana\\PROYECTO\\src', 'C:\\Users\\Ana\\proyecto')).toBe(true)
  })

  it.each(['CON', 'src/nul.txt', 'com1', 'LPT9.log', 'a:stream', 'file.txt:$DATA', 'name.', 'name ', 'a<b', 'D:\\x', '\\\\?\\C:\\x', '\\\\server\\share'])(
    'rechaza %s',
    (p) => {
      expect(() => g.resolve(p)).toThrowError()
    },
  )
})

describe('PathGuard con enlaces simbólicos reales', () => {
  it('bloquea un symlink que apunta fuera del proyecto', () => {
    const base = mkdtempSync(join(tmpdir(), 'zh-guard-'))
    const root = join(base, 'proyecto')
    const outside = join(base, 'fuera')
    mkdirSync(join(root, 'src'), { recursive: true })
    mkdirSync(outside)
    writeFileSync(join(outside, 'secreto.txt'), 'x')
    symlinkSync(outside, join(root, 'enlace'), 'dir')
    const g = new PathGuard(root)
    expect(g.resolve('src/nuevo.ts')).toBe(join(root, 'src', 'nuevo.ts'))
    expect(() => g.resolve('enlace/secreto.txt')).toThrowError(/fuera del proyecto/)
    expect(() => g.resolve('enlace/no-existe/aun.txt')).toThrowError(/fuera del proyecto/)
  })
})
