import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Firestore } from '@google-cloud/firestore';
import type { Config } from './config.js';
import { clone } from './content.js';
import { SyncError } from './types.js';
import type { Pair, Side } from './types.js';

export type Records = Record<string, unknown>;
export interface Lease { owner: string; expiresAt: number }
export interface Change { key: string; value?: unknown }
export interface Store {
  acquire(ttl: number): Promise<Lease | null>;
  renew(lease: Lease, ttl: number): Promise<void>;
  release(lease: Lease): Promise<void>;
  read(): Promise<Records>;
  commit(lease: Lease, changes: Change[]): Promise<void>;
  close(): Promise<void>;
}
function checkLease(current: Lease | undefined, lease: Lease): void {
  if (!current || current.owner !== lease.owner || current.expiresAt <= Date.now()) throw new SyncError('lease_lost');
}
export class MemoryStore implements Store {
  records: Records;
  private lease?: Lease;
  constructor(records: Records = {}) { this.records = clone(records); }
  async acquire(ttl: number): Promise<Lease | null> {
    if (this.lease && this.lease.expiresAt > Date.now()) return null;
    this.lease = { owner: randomUUID(), expiresAt: Date.now() + ttl };
    return clone(this.lease);
  }
  async renew(lease: Lease, ttl: number): Promise<void> { checkLease(this.lease, lease); this.lease!.expiresAt = Date.now() + ttl; }
  async release(lease: Lease): Promise<void> { if (this.lease?.owner === lease.owner) this.lease = undefined; }
  async read(): Promise<Records> { return clone(this.records); }
  async commit(lease: Lease, changes: Change[]): Promise<void> {
    checkLease(this.lease, lease);
    for (const c of changes) if (c.value === undefined) delete this.records[c.key]; else this.records[c.key] = clone(c.value);
  }
  async close(): Promise<void> {}
}

export class SqliteStore implements Store {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY CHECK (id=1), owner TEXT NOT NULL, expires INTEGER NOT NULL);');
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private current(): Lease | undefined {
    const row = this.db.prepare('SELECT owner, expires FROM lease WHERE id=1').get();
    return row ? { owner: String(row.owner), expiresAt: Number(row.expires) } : undefined;
  }
  async acquire(ttl: number): Promise<Lease | null> {
    return this.transaction(() => {
      if ((this.current()?.expiresAt ?? 0) > Date.now()) return null;
      const lease = { owner: randomUUID(), expiresAt: Date.now() + ttl };
      this.db.prepare('INSERT OR REPLACE INTO lease VALUES (1, ?, ?)').run(lease.owner, lease.expiresAt);
      return lease;
    });
  }
  async renew(lease: Lease, ttl: number): Promise<void> {
    this.transaction(() => { checkLease(this.current(), lease); this.db.prepare('UPDATE lease SET expires=? WHERE id=1').run(Date.now() + ttl); });
  }
  async release(lease: Lease): Promise<void> { this.db.prepare('DELETE FROM lease WHERE id=1 AND owner=?').run(lease.owner); }
  async read(): Promise<Records> {
    return Object.fromEntries(this.db.prepare('SELECT key, value FROM records').all().map(row => [String(row.key), JSON.parse(String(row.value))]));
  }
  async commit(lease: Lease, changes: Change[]): Promise<void> {
    this.transaction(() => {
      checkLease(this.current(), lease);
      for (const c of changes) {
        if (c.value === undefined) this.db.prepare('DELETE FROM records WHERE key=?').run(c.key);
        else this.db.prepare('INSERT OR REPLACE INTO records (key, value) VALUES (?, ?)').run(c.key, JSON.stringify(c.value));
      }
    });
  }
  async close(): Promise<void> { this.db.close(); }
}

export class FirestoreStore implements Store {
  private db: Firestore;
  private root: FirebaseFirestore.DocumentReference;
  constructor(projectId: string, pairId: string, databaseId = '(default)') {
    this.db = new Firestore({ projectId, databaseId });
    this.root = this.db.collection('calendarSync').doc(pairId);
  }
  async acquire(ttl: number): Promise<Lease | null> {
    const owner = randomUUID();
    return this.db.runTransaction(async transaction => {
      const current = (await transaction.get(this.root)).data()?.lease as Lease | undefined;
      if (current && current.expiresAt > Date.now()) return null;
      const lease = { owner, expiresAt: Date.now() + ttl };
      transaction.set(this.root, { lease }, { merge: true });
      return lease;
    });
  }
  async renew(lease: Lease, ttl: number): Promise<void> {
    await this.db.runTransaction(async transaction => {
      checkLease((await transaction.get(this.root)).data()?.lease as Lease | undefined, lease);
      transaction.set(this.root, { lease: { owner: lease.owner, expiresAt: Date.now() + ttl } }, { merge: true });
    });
  }
  async release(lease: Lease): Promise<void> {
    await this.db.runTransaction(async transaction => {
      const current = (await transaction.get(this.root)).data()?.lease as Lease | undefined;
      if (current?.owner === lease.owner) transaction.set(this.root, { lease: null }, { merge: true });
    });
  }
  async read(): Promise<Records> {
    const docs = await this.root.collection('records').get();
    return Object.fromEntries(docs.docs.map(doc => [doc.data().key as string, doc.data().value]));
  }
  async commit(lease: Lease, changes: Change[]): Promise<void> {
    if (changes.length > 400) throw new SyncError('transaction_too_large');
    // Never put external side effects in this callback: Firestore can replay it.
    await this.db.runTransaction(async transaction => {
      checkLease((await transaction.get(this.root)).data()?.lease as Lease | undefined, lease);
      for (const c of changes) {
        const ref = this.root.collection('records').doc(Buffer.from(c.key).toString('base64url'));
        if (c.value === undefined) transaction.delete(ref);
        else transaction.set(ref, { key: c.key, value: JSON.parse(JSON.stringify(c.value)) });
      }
    });
  }
  async close(): Promise<void> { await this.db.terminate(); }
}

export async function openStore(config: Config): Promise<Store> {
  if (config.storage.type === 'firestore') return new FirestoreStore(config.storage.projectId, config.pairId, config.storage.databaseId);
  await mkdir(dirname(config.storage.path), { recursive: true, mode: 0o700 });
  return new SqliteStore(config.storage.path);
}

/** A leased snapshot. Each checkpoint is durable before its in-memory version changes. */
export class Repository {
  private pairsByEvent = new Map<string, string>();
  constructor(public store: Store, public lease: Lease, public records: Records) {
    for (const [key, value] of Object.entries(records)) if (key.startsWith('pair/')) this.index(key, value as Pair);
  }
  private index(key: string, pair: Pair): void {
    this.pairsByEvent.set(`A/${pair.a}`, key); this.pairsByEvent.set(`B/${pair.b}`, key);
  }
  findPair(side: Side, id: string): Pair | undefined {
    const key = this.pairsByEvent.get(`${side}/${id}`); return key ? this.get<Pair>(key) : undefined;
  }
  get<T>(key: string): T | undefined { return clone(this.records[key] as T | undefined); }
  list<T>(prefix: string): [string, T][] {
    return Object.entries(this.records).filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, clone(value as T)]);
  }
  async put(changes: Change[]): Promise<void> {
    await this.store.commit(this.lease, changes);
    for (const c of changes) {
      if (c.key.startsWith('pair/')) {
        const before = this.records[c.key] as Pair | undefined;
        if (before) { this.pairsByEvent.delete(`A/${before.a}`); this.pairsByEvent.delete(`B/${before.b}`); }
        if (c.value) this.index(c.key, c.value as Pair);
      }
      if (c.value === undefined) delete this.records[c.key]; else this.records[c.key] = clone(c.value);
    }
  }
}
