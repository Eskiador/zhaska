import { describe, expect, it } from 'vitest'
import { modelProfile, modelSizeB } from '../../src/shared/agent/modelProfiles'
import { agentSystemPrompt } from '../../src/shared/agent/agentPrompt'
import { offeredTools } from '../../src/agent/engine/loop'
import { jsonProtocol, nativeProtocol } from '../../src/agent/engine/protocols'

const perms = { read: 'allow', write: 'ask', execute: 'ask', install: 'ask', internet: 'block' } as const

describe('perfiles por modelo', () => {
  it.each([
    ['gemma4:e2b-it-qat', 2],
    ['gemma4:e4b-it-qat', 4],
    ['gemma4:12b-it-qat', 12],
    ['gemma4:26b-a4b-it-qat', 26],
    ['qwen3:8b', 8],
    ['llama3:latest', null],
  ])('%s → %s B', (m, b) => {
    expect(modelSizeB(m)).toBe(b)
  })

  it('todos usan el prompt completo (medido: E4B 6/7 completo frente a 4/7 compacto); los pequeños, con menos temperatura', () => {
    expect(modelProfile('gemma4:e4b-it-qat')).toMatchObject({ style: 'full', tools: 'all', maxTemperature: 0.15 })
    expect(modelProfile('gemma4:12b-it-qat')).toMatchObject({ style: 'full', tools: 'all', maxTemperature: 1.5 })
    expect(modelProfile('llama3:latest').style).toBe('full')
    expect(modelProfile('gemma4:e4b-it-qat', 'compact')).toMatchObject({ style: 'compact', tools: 'core' }) // se puede forzar para medir
  })
})

describe('herramientas ofrecidas', () => {
  const names = (t: { name: string }[]) => t.map((x) => x.name)

  it('no se ofrecen las bloqueadas ni read_attachment sin adjuntos', () => {
    const full = names(offeredTools({ permissions: perms }, modelProfile('gemma4:12b-it-qat')))
    expect(full).toContain('update_plan')
    expect(full).toContain('install_dependencies')
    expect(full).not.toContain('read_attachment')
    const blocked = names(offeredTools({ permissions: { ...perms, write: 'block', execute: 'block', install: 'block' } }, modelProfile('gemma4:12b-it-qat')))
    expect(blocked).not.toContain('edit_file')
    expect(blocked).not.toContain('execute_command')
    expect(blocked).not.toContain('install_dependencies')
    expect(blocked).toContain('read_file')
    const withAtt = names(offeredTools({ permissions: perms, attachments: [{ id: 'a', name: 'x.pdf', kind: 'pdf', textFile: '/x', unzipDir: null, chars: 1 }] }, modelProfile('gemma4:12b-it-qat')))
    expect(withAtt).toContain('read_attachment')
  })

  it('el perfil compacto quita las de planificación y el prompt solo nombra lo ofrecido', () => {
    const small = offeredTools({ permissions: perms }, modelProfile('gemma4:e4b-it-qat', 'compact'))
    expect(names(small)).not.toContain('update_plan')
    expect(names(small)).toContain('edit_file')
    const prompt = agentSystemPrompt({ projectName: 'p', tree: '', config: '', guide: null, protocol: nativeProtocol.instructions(small), os: 'x', style: 'compact', tools: names(small) })
    expect(prompt).toMatch(/Ejemplo de edit_file/)
    expect(prompt).not.toMatch(/update_plan|read_attachment/)
    const json = jsonProtocol.instructions(small)
    expect(json).toContain('- edit_file(')
    expect(json).not.toContain('- update_plan(')
    expect(JSON.stringify(jsonProtocol.request(small))).not.toContain('update_plan')
    expect(nativeProtocol.request(small).tools).toHaveLength(small.length)
  })
})
