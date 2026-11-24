import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TerminalService, resolveShell } from '../../src/main/services/terminals'

describe('terminal real (node-pty)', () => {
  it('abre una shell en la carpeta del proyecto, ejecuta comandos y se cierra', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'zh-pty-')))
    let out = ''
    let exit: number | null = null
    const svc = new TerminalService((channel, payload) => {
      if (channel === 'terminal.data') out += (payload as { data: string }).data
      else exit = (payload as { exitCode: number }).exitCode
    })
    const t = svc.create('p1', root, 'powershell', 100, 30)
    expect(t).toMatchObject({ projectId: 'p1', alive: true })
    expect(svc.list('p1')).toHaveLength(1)
    // Espera al primer texto de la shell (en Windows PowerShell puede tardar varios segundos en arrancar)
    for (let i = 0; i < 150 && !out; i++) await new Promise((r) => setTimeout(r, 100))
    await new Promise((r) => setTimeout(r, 300))
    svc.write(t.id, process.platform === 'win32' ? 'echo "ZH-$(6*7)"; pwd\r' : 'echo "ZH-$((6*7))"; pwd\r')
    for (let i = 0; i < 150 && !(out.includes('ZH-42') && out.includes(root.split(/[\\/]/).pop()!)); i++) await new Promise((r) => setTimeout(r, 100))
    expect(out).toContain('ZH-42')
    expect(out).toContain(root.split(/[\\/]/).pop()!) // la shell arranca en la raíz del proyecto
    svc.resize(t.id, 140, 40)
    svc.write(t.id, 'exit\r')
    for (let i = 0; i < 150 && exit === null; i++) await new Promise((r) => setTimeout(r, 100))
    expect(exit).toBe(0)
    svc.killProject('p1')
    expect(svc.list('p1')).toHaveLength(0)
  }, 45_000)

  it('elige la shell según el sistema', () => {
    const sh = resolveShell('powershell')
    if (process.platform === 'win32') expect(sh.label).toBe('PowerShell')
    else expect(sh.args).toEqual(['-l'])
  })
})
