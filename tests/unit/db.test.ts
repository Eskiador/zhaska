import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrate, openDatabase, schemaVersion } from '../../src/main/db/database'
import { MIGRATIONS } from '../../src/main/db/migrations'
import { ConversationsRepo, ProjectsRepo, SettingsRepo, rootKey } from '../../src/main/db/repos'
import { createBackup, ensureDailyBackup, listBackups } from '../../src/main/db/backups'

const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), 'zh-db-'))
  const file = join(dir, 'zhaska.db')
  const db = openDatabase(file)
  migrate(db)
  return { db, dir, file }
}

describe('migraciones', () => {
  it('aplica todas y es idempotente', () => {
    const { db } = fresh()
    const latest = MIGRATIONS.at(-1)!.version
    expect(schemaVersion(db)).toBe(latest)
    expect(migrate(db)).toBe(latest)
  })
})

describe('proyectos', () => {
  it('reutiliza el proyecto de la misma carpeta y lo reordena al abrirlo', async () => {
    const { db } = fresh()
    const repo = new ProjectsRepo(db, 'linux')
    const a = repo.touchByRoot('/p/a', 'a')
    await new Promise((r) => setTimeout(r, 5))
    const b = repo.touchByRoot('/p/b', 'b')
    expect(repo.listRecent().map((p) => p.id)).toEqual([b.id, a.id])
    await new Promise((r) => setTimeout(r, 5))
    expect(repo.touchByRoot('/p/a', 'a').id).toBe(a.id)
    expect(repo.listRecent()[0]!.id).toBe(a.id)
  })

  it('en Windows la misma carpeta con otras mayúsculas es el mismo proyecto', () => {
    const { db } = fresh()
    const repo = new ProjectsRepo(db, 'win32')
    const a = repo.touchByRoot('C:\\Proyectos\\App', 'App')
    expect(repo.touchByRoot('c:\\proyectos\\app', 'app').id).toBe(a.id)
    expect(rootKey('C:\\X\\', 'win32')).toBe('c:\\x')
  })

  it('quitar de recientes conserva las conversaciones', () => {
    const { db } = fresh()
    const projects = new ProjectsRepo(db, 'linux')
    const convs = new ConversationsRepo(db)
    const p = projects.touchByRoot('/p/a', 'a')
    convs.create(p.id, 'Hola')
    projects.hide(p.id)
    expect(projects.listRecent()).toHaveLength(0)
    expect(projects.touchByRoot('/p/a', 'a').id).toBe(p.id)
    expect(convs.list(p.id)).toHaveLength(1)
  })
})

describe('conversaciones y mensajes', () => {
  it('persisten y sobreviven a cerrar y reabrir la base de datos', () => {
    const { db, file } = fresh()
    const p = new ProjectsRepo(db, 'linux').touchByRoot('/p/a', 'a')
    const repo = new ConversationsRepo(db)
    const c = repo.create(p.id)
    repo.addMessage(c.id, 'user', [{ kind: 'text', text: 'Crea un login' }])
    repo.addMessage(c.id, 'assistant', [{ kind: 'text', text: 'Hecho' }], 'gemma4:12b-it-qat')
    repo.rename(c.id, 'Login')
    db.close()

    const db2 = openDatabase(file)
    migrate(db2)
    const repo2 = new ConversationsRepo(db2)
    const [conv] = repo2.list(p.id)
    expect(conv).toMatchObject({ title: 'Login', messageCount: 2 })
    const msgs = repo2.messages(c.id)
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(msgs[1]).toMatchObject({ model: 'gemma4:12b-it-qat', blocks: [{ kind: 'text', text: 'Hecho' }] })
  })

  it('borrar una conversación borra sus mensajes', () => {
    const { db } = fresh()
    const p = new ProjectsRepo(db, 'linux').touchByRoot('/p/a', 'a')
    const repo = new ConversationsRepo(db)
    const c = repo.create(p.id)
    repo.addMessage(c.id, 'user', [])
    repo.delete(c.id)
    expect((db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n).toBe(0)
  })

  it('rechaza mensajes en conversaciones inexistentes', () => {
    const { db } = fresh()
    expect(() => new ConversationsRepo(db).addMessage('no-existe', 'user', [])).toThrowError(/no encontrada/)
  })
})

describe('ajustes', () => {
  it('guarda valores JSON y limita su tamaño', () => {
    const { db } = fresh()
    const s = new SettingsRepo(db)
    s.set('temperature', 0.4)
    s.set('protectedPatterns', ['.env*'])
    expect(s.getAll()).toEqual({ temperature: 0.4, protectedPatterns: ['.env*'] })
    expect(s.get('missing', 7)).toBe(7)
    expect(() => s.set('big', 'x'.repeat(70_000))).toThrowError(/demasiado grande/)
  })
})

describe('copias de seguridad', () => {
  it('crea copias restaurables y una sola diaria por día', async () => {
    const { db, dir } = fresh()
    new SettingsRepo(db).set('k', 1)
    const backups = join(dir, 'backups')
    const b = await createBackup(db, backups, 'manual')
    expect(b.reason).toBe('manual')
    expect(await ensureDailyBackup(db, backups, 7)).not.toBeNull()
    expect(await ensureDailyBackup(db, backups, 7)).toBeNull()
    expect(listBackups(backups)).toHaveLength(2)
    const restored = openDatabase(join(backups, b.file))
    expect(new SettingsRepo(restored).get('k', 0)).toBe(1)
    expect(readdirSync(backups).every((f) => f.startsWith('zhaska-'))).toBe(true)
  })
})
