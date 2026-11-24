import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrate, openDatabase } from '../../src/main/db/database'
import { ProjectsRepo, SettingsRepo } from '../../src/main/db/repos'
import { createBackup, listBackups } from '../../src/main/db/backups'
import { applyPending, inspectDatabase, LATEST_SCHEMA, pendingOperation, schedule, takeLastOperation } from '../../src/main/db/restore'
import { exportData, stageImport } from '../../src/main/data/portable'
import { CheckpointJanitor } from '../../src/main/services/checkpoints'
import { makeZip } from '../fixtures/attachments'

/** Carpeta de datos como la de la app: data/zhaska.db, backups/, import/, attachments/. */
function userData() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'zh-data-')))
  const paths = {
    root,
    dataDir: join(root, 'data'),
    dbPath: join(root, 'data', 'zhaska.db'),
    backupsDir: join(root, 'backups'),
    importDir: join(root, 'import'),
    attachmentsDir: join(root, 'attachments'),
    tmp: join(root, 'data', 'tmp'),
  }
  mkdirSync(paths.dataDir, { recursive: true })
  const db = openDatabase(paths.dbPath)
  migrate(db)
  return { ...paths, db }
}

describe('copias y restauración', () => {
  it('las copias son archivos autónomos y se comprueban antes de usarlas', async () => {
    const u = userData()
    new ProjectsRepo(u.db).touchByRoot('/proyectos/a', 'a')
    const b = await createBackup(u.db, u.backupsDir, 'manual')
    expect(readdirSync(u.backupsDir)).toEqual([b.file]) // sin -wal ni -shm
    const sum = inspectDatabase(join(u.backupsDir, b.file), u.tmp)
    expect(sum).toMatchObject({ schemaVersion: LATEST_SCHEMA, projects: 1 })
    expect(readdirSync(u.backupsDir)).toEqual([b.file]) // la comprobación no deja rastro
    expect(existsSync(u.tmp) ? readdirSync(u.tmp) : []).toEqual([])
  })

  it('rechaza archivos que no son de ZHASKA, dañados o de una versión más nueva', () => {
    const u = userData()
    const notDb = join(u.root, 'x.db')
    writeFileSync(notDb, 'hola')
    expect(() => inspectDatabase(notDb, u.tmp)).toThrowError(/no es una base de datos válida/)
    const other = join(u.root, 'otra.db')
    const o = openDatabase(other)
    o.exec('CREATE TABLE t (x)')
    o.close()
    expect(() => inspectDatabase(other, u.tmp)).toThrowError(/no es una base de datos de ZHASKA/)
    const newer = join(u.root, 'nueva.db')
    const n = openDatabase(newer)
    migrate(n)
    n.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(LATEST_SCHEMA + 1, 'futura', Date.now())
    n.close()
    expect(() => inspectDatabase(newer, u.tmp)).toThrowError(/versión más nueva/)
    const broken = join(u.root, 'rota.db')
    const real = readFileSync(join(u.dbPath))
    writeFileSync(broken, Buffer.concat([real.subarray(0, 100), Buffer.alloc(4096, 0xff)]))
    expect(() => inspectDatabase(broken, u.tmp)).toThrow()
  })

  it('restaura una copia al arrancar y guarda antes el estado actual (se puede deshacer)', async () => {
    const u = userData()
    const settings = new SettingsRepo(u.db)
    settings.set('temperature', 0.1)
    const b = await createBackup(u.db, u.backupsDir, 'manual')
    settings.set('temperature', 0.9) // cambio posterior a la copia
    schedule(u.dataDir, { kind: 'restore', source: b.file, label: 'copia de prueba' })
    expect(pendingOperation(u.dataDir)?.source).toBe(b.file)
    u.db.close() // la app se cierra para reiniciar

    const op = await applyPending(u)
    expect(op).toMatchObject({ kind: 'restore', ok: true })
    expect(pendingOperation(u.dataDir)).toBeNull()
    const after = openDatabase(u.dbPath)
    expect(new SettingsRepo(after).get('temperature', 0)).toBe(0.1)
    after.close()
    // La copia «antes de restaurar» tiene el estado que había (0.9)
    const safety = listBackups(u.backupsDir).find((x) => x.reason === 'pre-restore')!
    expect(safety.file).toBe(op!.safetyBackup)
    const s = openDatabase(join(u.backupsDir, safety.file))
    expect(new SettingsRepo(s).get('temperature', 0)).toBe(0.9)
    s.close()
    // El aviso se muestra una sola vez
    expect(takeLastOperation(u.dataDir)?.ok).toBe(true)
    expect(takeLastOperation(u.dataDir)).toBeNull()
  })

  it('si la copia falla la comprobación, no se toca la base de datos actual', async () => {
    const u = userData()
    new SettingsRepo(u.db).set('temperature', 0.7)
    const b = await createBackup(u.db, u.backupsDir, 'manual')
    writeFileSync(join(u.backupsDir, b.file), 'dañada')
    schedule(u.dataDir, { kind: 'restore', source: b.file, label: 'rota' })
    u.db.close()
    const op = await applyPending(u)
    expect(op?.ok).toBe(false)
    expect(op?.error).toMatch(/no es una base de datos válida/)
    const db = openDatabase(u.dbPath)
    expect(new SettingsRepo(db).get('temperature', 0)).toBe(0.7)
    db.close()
    expect(pendingOperation(u.dataDir)).toBeNull() // no se reintenta en bucle
    expect(existsSync(`${u.dbPath}.incoming`)).toBe(false)
  })

  it('rechaza nombres de copia que no son de la carpeta de copias', () => {
    const u = userData()
    schedule(u.dataDir, { kind: 'restore', source: '../../etc/passwd', label: 'x' })
    return applyPending(u).then((op) => expect(op?.error).toMatch(/Nombre de copia no válido/))
  })
})

describe('exportar e importar', () => {
  it('ida y vuelta con adjuntos: exportar, preparar e importar al arrancar', async () => {
    const a = userData()
    new ProjectsRepo(a.db).touchByRoot('/proyectos/web', 'web')
    new SettingsRepo(a.db).set('numCtx', 16384)
    const sha = 'ab' + 'c'.repeat(62)
    mkdirSync(join(a.attachmentsDir, 'ab', sha, 'unzipped', 'src'), { recursive: true })
    writeFileSync(join(a.attachmentsDir, 'ab', sha, 'original.pdf'), 'PDF')
    writeFileSync(join(a.attachmentsDir, 'ab', sha, 'unzipped', 'src', 'a.ts'), 'export {}')
    const out = join(a.root, 'mis-datos.zhaska')
    const r = await exportData({ db: a.db, target: out, attachmentsDir: a.attachmentsDir, includeAttachments: true, tmpDir: a.tmp, appVersion: '0.1.0' })
    expect(r.attachments).toBe(2)
    expect(readdirSync(a.root)).not.toContain('mis-datos.zhaska.part')

    // Otro equipo: datos distintos
    const b = userData()
    new SettingsRepo(b.db).set('numCtx', 8192)
    const summary = await stageImport({ file: out, importDir: b.importDir, tmpDir: b.tmp })
    expect(summary).toMatchObject({ projects: 1, attachmentFiles: 2, appVersion: '0.1.0', fileName: 'mis-datos.zhaska' })
    schedule(b.dataDir, { kind: 'import', source: summary.token, label: 'datos importados' })
    b.db.close()
    const op = await applyPending(b)
    expect(op).toMatchObject({ kind: 'import', ok: true })
    const db = openDatabase(b.dbPath)
    expect(new SettingsRepo(db).get('numCtx', 0)).toBe(16384)
    expect(new ProjectsRepo(db).listRecent().map((p) => p.name)).toEqual(['web'])
    db.close()
    expect(readFileSync(join(b.attachmentsDir, 'ab', sha, 'unzipped', 'src', 'a.ts'), 'utf8')).toBe('export {}')
    expect(listBackups(b.backupsDir).some((x) => x.reason === 'pre-import')).toBe(true)
    expect(existsSync(join(b.importDir, summary.token))).toBe(false)
  })

  it('también importa una copia .db suelta', async () => {
    const a = userData()
    new ProjectsRepo(a.db).touchByRoot('/p/uno', 'uno')
    const copy = await createBackup(a.db, a.backupsDir, 'manual')
    const b = userData()
    const s = await stageImport({ file: join(a.backupsDir, copy.file), importDir: b.importDir, tmpDir: b.tmp })
    expect(s).toMatchObject({ projects: 1, appVersion: null, attachmentFiles: 0 })
  })

  const manifest = JSON.stringify({ app: 'ZHASKA', format: 1, appVersion: '0.1.0', schemaVersion: LATEST_SCHEMA, createdAt: 1, includesAttachments: true })
  it.each([
    ['sale de la carpeta', [['manifest.json', manifest], ['../../evil.txt', 'x']], /salir de la carpeta/],
    ['ruta absoluta', [['manifest.json', manifest], ['/etc/evil', 'x']], /ruta absoluta/],
    ['elemento inesperado', [['manifest.json', manifest], ['autorun.inf', 'x']], /elemento inesperado/],
    ['adjunto mal ubicado', [['manifest.json', manifest], ['attachments/zz/123/a.txt', 'x']], /elemento inesperado/],
    ['ejecutable', [['manifest.json', manifest], [`attachments/ab/ab${'c'.repeat(62)}/unzipped/run.exe`, 'MZ']], /ejecutable/],
    ['nombre reservado', [['manifest.json', manifest], [`attachments/ab/ab${'c'.repeat(62)}/CON`, 'x']], /reservado/],
    ['sin manifest', [['zhaska.db', 'x']], /manifest\.json/],
    ['no es de ZHASKA', [['manifest.json', '{"app":"Otra"}'], ['zhaska.db', 'x']], /No es una exportación de ZHASKA/],
  ])('rechaza un archivo manipulado: %s', async (_name, entries, re) => {
    const u = userData()
    const file = join(u.root, 'malo.zhaska')
    writeFileSync(file, makeZip((entries as [string, string][]).map(([name, data]) => ({ name, data }))))
    await expect(stageImport({ file, importDir: u.importDir, tmpDir: u.tmp })).rejects.toThrowError(re)
    expect(readdirSync(u.importDir)).toEqual([]) // no queda nada preparado
    expect(existsSync(join(u.root, '..', 'evil.txt'))).toBe(false)
  })

  it('rechaza enlaces simbólicos dentro de la exportación', async () => {
    const u = userData()
    const file = join(u.root, 'enlace.zhaska')
    writeFileSync(file, makeZip([{ name: 'manifest.json', data: manifest }, { name: `attachments/ab/ab${'c'.repeat(62)}/x`, data: '/etc/passwd', symlink: true }]))
    await expect(stageImport({ file, importDir: u.importDir, tmpDir: u.tmp })).rejects.toThrowError(/enlace simbólico/)
  })
})

describe('retención de instantáneas', () => {
  it('conserva las de cambios pendientes y recientes; borra las antiguas', () => {
    const u = userData()
    const blobs = join(u.root, 'checkpoints', 'p1', 'blobs')
    mkdirSync(blobs, { recursive: true })
    const h = (c: string) => c.repeat(64)
    const old = Date.now() - 90 * 86_400_000
    for (const c of ['a', 'b', 'c', 'd', 'e']) {
      writeFileSync(join(blobs, h(c)), c.repeat(100))
      utimesSync(join(blobs, h(c)), old / 1000, old / 1000)
    }
    writeFileSync(join(blobs, h('f')), 'nueva') // recién escrita por una tarea en curso
    writeFileSync(join(blobs, 'no-es-un-hash.txt'), 'x')
    const p = new ProjectsRepo(u.db).touchByRoot('/p', 'p')
    u.db.prepare("INSERT INTO conversations (id, project_id, title, created_at, updated_at) VALUES ('c1', ?, 't', 0, 0)").run(p.id)
    u.db.prepare("INSERT INTO agent_tasks (id, conversation_id, project_id, model, status, started_at) VALUES ('t1', 'c1', ?, 'm', 'completed', 0)").run(p.id)
    const change = u.db.prepare('INSERT INTO file_changes (id, task_id, project_id, rel_path, kind, before_hash, after_hash, additions, deletions, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)')
    change.run('x1', 't1', p.id, 'a.ts', 'modify', h('a'), h('b'), 'pending', old) // pendiente: se conserva aunque sea antigua
    change.run('x2', 't1', p.id, 'b.ts', 'modify', h('c'), null, 'accepted', Date.now() - 86_400_000) // reciente
    change.run('x3', 't1', p.id, 'c.ts', 'modify', h('d'), h('e'), 'accepted', old) // antigua y resuelta
    const j = new CheckpointJanitor({ db: u.db, root: join(u.root, 'checkpoints'), retentionDays: () => 30 })
    expect(j.usage().blobs).toBe(6)
    const r = j.collect()
    expect(r).toEqual({ removed: 2, freedBytes: 200 })
    expect(readdirSync(blobs).sort()).toEqual([h('a'), h('b'), h('c'), h('f'), 'no-es-un-hash.txt'].sort())
  })
})
