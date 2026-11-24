/**
 * Migraciones versionadas (ARCHITECTURE §5.2). Nunca se edita una migración publicada: se añade otra.
 * Las tablas del agente (tareas, actividad, cambios, checkpoints, permisos) llegan con sus fases.
 */
export interface Migration {
  version: number
  name: string
  sql: string
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'init',
    sql: `
      CREATE TABLE projects (
        id             TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        root_path      TEXT NOT NULL,
        root_key       TEXT NOT NULL UNIQUE,      -- ruta normalizada (minúsculas en Windows)
        created_at     INTEGER NOT NULL,
        last_opened_at INTEGER NOT NULL,
        hidden         INTEGER NOT NULL DEFAULT 0, -- "quitar de recientes" sin borrar su historial
        settings_json  TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX idx_projects_recent ON projects (hidden, last_opened_at DESC);

      CREATE TABLE conversations (
        id         TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
        title      TEXT NOT NULL,
        model      TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        archived   INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_conversations_project ON conversations (project_id, updated_at DESC);

      CREATE TABLE messages (
        id              TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
        role            TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system')),
        blocks_json     TEXT NOT NULL,
        model           TEXT,
        tokens_in       INTEGER,
        tokens_out      INTEGER,
        created_at      INTEGER NOT NULL
      );
      CREATE INDEX idx_messages_conversation ON messages (conversation_id, created_at);

      CREATE TABLE settings (
        key        TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'chat-metrics-and-benchmarks',
    sql: `
      ALTER TABLE messages ADD COLUMN metrics_json TEXT;

      CREATE TABLE benchmarks (
        id             TEXT PRIMARY KEY,
        model          TEXT NOT NULL,
        created_at     INTEGER NOT NULL,
        ollama_version TEXT,
        hardware_json  TEXT NOT NULL,
        result_json    TEXT NOT NULL
      );
      CREATE INDEX idx_benchmarks_model ON benchmarks (model, created_at DESC);
    `,
  },
  {
    version: 3,
    name: 'agent-tasks-changes-rules',
    sql: `
      CREATE TABLE agent_tasks (
        id              TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
        project_id      TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
        model           TEXT NOT NULL,
        status          TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
        started_at      INTEGER NOT NULL,
        finished_at     INTEGER,
        steps           INTEGER,
        error           TEXT
      );
      CREATE INDEX idx_agent_tasks_conversation ON agent_tasks (conversation_id, started_at);

      CREATE TABLE file_changes (
        id          TEXT PRIMARY KEY,
        task_id     TEXT NOT NULL REFERENCES agent_tasks (id) ON DELETE CASCADE,
        project_id  TEXT NOT NULL,
        rel_path    TEXT NOT NULL,
        kind        TEXT NOT NULL CHECK (kind IN ('create', 'modify', 'delete')),
        before_hash TEXT,
        after_hash  TEXT,
        additions   INTEGER NOT NULL,
        deletions   INTEGER NOT NULL,
        status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
        updated_at  INTEGER NOT NULL,
        UNIQUE (task_id, rel_path)
      );

      CREATE TABLE permission_rules (
        id         TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
        action     TEXT NOT NULL,
        pattern    TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (project_id, action, pattern)
      );
    `,
  },
  {
    version: 4,
    name: 'activity-events',
    sql: `
      CREATE TABLE activity_events (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id      TEXT NOT NULL REFERENCES agent_tasks (id) ON DELETE CASCADE,
        seq          INTEGER NOT NULL,
        type         TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        ts           INTEGER NOT NULL
      );
      CREATE INDEX idx_activity_task ON activity_events (task_id, seq);
    `,
  },
  {
    version: 5,
    name: 'attachments',
    sql: `
      -- Adjuntos (Fase 8): los archivos viven en userData/attachments/<aa>/<sha256>/, aquí solo los metadatos
      CREATE TABLE attachments (
        id         TEXT PRIMARY KEY,
        sha256     TEXT NOT NULL,
        file_name  TEXT NOT NULL,
        ext        TEXT NOT NULL,
        kind       TEXT NOT NULL,
        size       INTEGER NOT NULL,
        status     TEXT NOT NULL CHECK (status IN ('processing', 'ready', 'error')),
        error      TEXT,
        meta_json  TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_attachments_sha ON attachments (sha256);

      CREATE TABLE message_attachments (
        message_id    TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
        attachment_id TEXT NOT NULL REFERENCES attachments (id) ON DELETE CASCADE,
        position      INTEGER NOT NULL,
        PRIMARY KEY (message_id, attachment_id)
      );
      CREATE INDEX idx_message_attachments_att ON message_attachments (attachment_id);
    `,
  },
]
