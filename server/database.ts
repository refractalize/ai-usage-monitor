import { closeSync, mkdirSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CollectionError, canonical, type NormalizedSnapshot, type Window } from './models.ts';
import { DEFAULT_SCOPE, type Scope } from './providers.ts';
export const defaultDbPath = () =>
  process.env.AI_USAGE_DB ?? join(homedir(), '.local/share/ai-usage-monitor/usage-v2.sqlite3');
export interface Sample extends Window, Scope {
  collected_at: number;
  snapshot_id: number;
}
export interface Observation extends Scope {
  id: number;
  collected_at: number;
  windows: Window[];
  raw_response: unknown;
}
export class Store {
  db: DatabaseSync;
  constructor(path = defaultDbPath()) {
    if (path.startsWith('~/')) path = join(homedir(), path.slice(2));
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      closeSync(openSync(path, 'a', 0o600));
    }
    this.db = new DatabaseSync(path);
    const existing = this.db.prepare('PRAGMA table_info(snapshots)').all();
    if (
      existing.length &&
      !['provider', 'account'].every((name) => existing.some((c) => c.name === name))
    ) {
      this.db.close();
      throw new CollectionError(
        'This database uses the old schema. Select a fresh file with --db or AI_USAGE_DB; no migration is provided.',
      );
    }
    this.db.exec(`PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY, provider TEXT NOT NULL, account TEXT NOT NULL, collected_at REAL NOT NULL,
        raw_response TEXT NOT NULL, result_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS windows (snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
        limit_id TEXT, window_key TEXT NOT NULL, window_duration_minutes INTEGER, used_percent REAL,
        resets_at INTEGER, plan_type TEXT);
      CREATE INDEX IF NOT EXISTS windows_snapshot ON windows(snapshot_id);
      CREATE INDEX IF NOT EXISTS windows_weekly ON windows(window_duration_minutes, limit_id, resets_at);
      CREATE INDEX IF NOT EXISTS snapshots_collected ON snapshots(provider,account,collected_at);
      CREATE TABLE IF NOT EXISTS collection_attempts (id INTEGER PRIMARY KEY, provider TEXT NOT NULL, account TEXT NOT NULL, attempted_at REAL NOT NULL,
        succeeded INTEGER NOT NULL, message TEXT NOT NULL);
    `);
  }
  close() {
    this.db.close();
  }
  save(snapshot: NormalizedSnapshot, at = Date.now() / 1000, scope: Scope = DEFAULT_SCOPE) {
    const { windows, raw_response } = snapshot;
    const result = canonical(snapshot.deduplication_value);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Compare canonical content independent of object key order.
      const candidates = this.db
        .prepare(
          'SELECT result_json FROM snapshots WHERE provider=? AND account=? AND collected_at BETWEEN ? AND ?',
        )
        .all(scope.provider, scope.account, at - 60, at);
      const duplicate = candidates.some(
        (r) => canonical(JSON.parse(String(r.result_json))) === result,
      );
      if (!duplicate) {
        const inserted = this.db
          .prepare(
            'INSERT INTO snapshots(provider,account,collected_at,raw_response,result_json) VALUES (?,?,?,?,?)',
          )
          .run(scope.provider, scope.account, at, JSON.stringify(raw_response), result);
        const stmt = this.db.prepare('INSERT INTO windows VALUES (?,?,?,?,?,?,?)');
        for (const w of windows)
          stmt.run(
            inserted.lastInsertRowid,
            w.limit_id,
            w.window_key,
            w.window_duration_minutes,
            w.used_percent,
            w.resets_at,
            w.plan_type,
          );
      }
      this.db.exec('COMMIT');
      return !duplicate;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  attempt(at: number, success: boolean, message: string, scope: Scope = DEFAULT_SCOPE) {
    this.db
      .prepare(
        'INSERT INTO collection_attempts(provider,account,attempted_at,succeeded,message) VALUES (?,?,?,?,?)',
      )
      .run(scope.provider, scope.account, at, Number(success), message);
  }
  lastAttempt(scope: Scope = DEFAULT_SCOPE) {
    return this.db
      .prepare(
        'SELECT attempted_at,succeeded,message FROM collection_attempts WHERE provider=? AND account=? ORDER BY attempted_at DESC,id DESC LIMIT 1',
      )
      .get(scope.provider, scope.account) as
      | { attempted_at: number; succeeded: number; message: string }
      | undefined;
  }
  latest(scope: Scope = DEFAULT_SCOPE): Observation | null {
    const row = this.db
      .prepare(
        'SELECT * FROM snapshots WHERE provider=? AND account=? ORDER BY collected_at DESC,id DESC LIMIT 1',
      )
      .get(scope.provider, scope.account);
    return row ? this.observation(row) : null;
  }
  private observation(row: Record<string, unknown>): Observation {
    return {
      provider: row.provider as Scope['provider'],
      account: String(row.account),
      id: Number(row.id),
      collected_at: Number(row.collected_at),
      raw_response: JSON.parse(String(row.raw_response)),
      windows: this.db
        .prepare(
          'SELECT limit_id,window_key,window_duration_minutes,used_percent,resets_at,plan_type FROM windows WHERE snapshot_id=? ORDER BY rowid',
        )
        .all(Number(row.id)) as unknown as Window[],
    };
  }
  *observations(scope: Scope = DEFAULT_SCOPE): Generator<Observation> {
    for (const row of this.db
      .prepare('SELECT * FROM snapshots WHERE provider=? AND account=? ORDER BY collected_at,id')
      .iterate(scope.provider, scope.account))
      yield this.observation(row);
  }
  samples(scope: Scope = DEFAULT_SCOPE): Sample[] {
    return this.db
      .prepare(`SELECT w.*,s.collected_at,s.provider,s.account FROM windows w JOIN snapshots s ON s.id=w.snapshot_id
      WHERE s.provider=? AND s.account=? ORDER BY s.collected_at,s.id,w.rowid`)
      .all(scope.provider, scope.account) as unknown as Sample[];
  }
}
