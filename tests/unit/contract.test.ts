import { describe, expect, it } from 'vitest'
import { contract, events } from '../../src/shared/ipc/contract'
import { CHANNELS, EVENTS } from '../../src/shared/ipc/channels'

describe('contrato IPC', () => {
  it('el preload permite exactamente los canales del contrato', () => {
    expect([...CHANNELS].sort()).toEqual(Object.keys(contract).sort())
    expect([...EVENTS].sort()).toEqual(Object.keys(events).sort())
  })

  it('valida peticiones', () => {
    expect(contract['fs.read'].req.safeParse({ projectId: 'p', rel: 'src/a.ts' }).success).toBe(true)
    expect(contract['fs.read'].req.safeParse({ projectId: '', rel: 'a' }).success).toBe(false)
    expect(contract['projects.create'].req.safeParse({ name: 'x', parentDir: '/p', gitInit: 'sí' }).success).toBe(false)
    expect(contract['app.info'].req.safeParse(undefined).success).toBe(true)
  })
})
