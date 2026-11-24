import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkRequirements, detectDevTools } from '../../src/main/services/hardware'
import { BACKUP_NAME } from '../../src/main/db/backups'

const GB = 1024 ** 3

describe('requisitos del asistente inicial', () => {
  it.each([
    ['10.0.22631', true, /Windows 11/],
    ['10.0.19045', true, /Windows 10/],
    ['10.0.19044', false, /Windows 10/],
    ['10.0.17763', false, /Windows 10/],
  ])('Windows %s → compatible: %s', (release, ok, name) => {
    const r = checkRequirements('win32', release, 'x64', 16 * GB)
    expect(r.osOk).toBe(ok)
    expect(r.os).toMatch(name)
    if (!ok) expect(r.osNote).toMatch(/22H2/)
  })

  it('exige x64 en Windows y avisa con menos de 16 GB', () => {
    expect(checkRequirements('win32', '10.0.22631', 'ia32', 16 * GB).archOk).toBe(false)
    expect(checkRequirements('win32', '10.0.22631', 'arm64', 16 * GB).archOk).toBe(false)
    expect(checkRequirements('win32', '10.0.22631', 'x64', 15.8 * GB).ramOk).toBe(true) // 16 GB nominales
    expect(checkRequirements('win32', '10.0.22631', 'x64', 8 * GB).ramOk).toBe(false)
    expect(checkRequirements('darwin', '27.2.0', 'arm64', 16 * GB)).toMatchObject({ osOk: true, archOk: true })
  })
})

describe('herramientas de desarrollo', () => {
  it('detecta versiones y no confunde el alias de Python de la Microsoft Store', async () => {
    const answers: Record<string, string | null> = {
      'node --version': 'v24.11.0',
      'git --version': 'git version 2.47.1.windows.1',
      'python3 --version': null,
      'python --version': null,
      'py --version': 'Python was not found; run without arguments to install from the Microsoft Store',
    }
    const tools = await detectDevTools(async (c) => answers[c] ?? null)
    expect(tools).toEqual([
      { id: 'node', label: 'Node.js', version: '24.11.0' },
      { id: 'python', label: 'Python', version: null },
      { id: 'git', label: 'Git', version: '2.47.1' },
    ])
    const withPy = await detectDevTools(async (c) => (c.includes('python') || c.startsWith('py ') ? 'Python 3.13.1' : null))
    expect(withPy.find((t) => t.id === 'python')?.version).toBe('3.13.1')
    expect(withPy.find((t) => t.id === 'node')?.version).toBeNull()
  })
})

describe('empaquetado', () => {
  const yml = readFileSync(join(__dirname, '..', '..', 'electron-builder.yml'), 'utf8')

  it('instalador NSIS por usuario, sin administrador, en español y sin borrar los datos', () => {
    for (const line of ['oneClick: false', 'perMachine: false', 'allowElevation: false', 'deleteAppDataOnUninstall: false', 'installerLanguages: [es_ES]', 'allowToChangeInstallationDirectory: true']) expect(yml).toContain(line)
  })

  it('fusibles de seguridad e integridad del ASAR', () => {
    for (const line of ['runAsNode: false', 'enableNodeOptionsEnvironmentVariable: false', 'enableNodeCliInspectArguments: false', 'enableEmbeddedAsarIntegrityValidation: true', 'onlyLoadAppFromAsar: true', 'grantFileProtocolExtraPrivileges: false']) expect(yml).toContain(line)
    expect(yml).not.toMatch(/disableAsarIntegrity:\s*true/)
  })

  it('las copias «antes de actualizar» siguen el patrón de las copias', () => {
    expect(BACKUP_NAME.test('zhaska-20261123-120000-pre-update.db')).toBe(true)
  })
})
