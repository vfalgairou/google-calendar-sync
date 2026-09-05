import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FirestoreStore, MemoryStore, SqliteStore, type Store } from '../src/store.js';
import { testConfig } from './helpers.js';
import { identity } from '../src/config.js';
import { exportState, importState } from '../src/state.js';

if (process.env.REQUIRE_FIRESTORE && !process.env.FIRESTORE_EMULATOR_HOST) throw new Error('FIRESTORE_EMULATOR_HOST requis.');
const backends: [string, () => Store][] = [['memory', () => new MemoryStore()], ['sqlite', () => new SqliteStore(':memory:')]];
if (process.env.FIRESTORE_EMULATOR_HOST) backends.push(['firestore', () => new FirestoreStore('calendar-sync-test', randomUUID())]);
for (const [name, factory] of backends) {
  test(`${name}: exclusion, checkpoint atomique, renouvellement et transfert`, async () => {
    const store = factory(); const config = testConfig();
    try {
      const lease = await store.acquire(90_000); assert.ok(lease);
      assert.equal(await store.acquire(90_000), null);
      await store.commit(lease, [{ key: 'meta', value: { version: 1, identity: identity(config) } }, { key: 'pair/example', value: { a: 'x', b: 'y' } }]);
      await assert.rejects(store.commit({ owner: 'wrong', expiresAt: Date.now() + 1000 }, [{ key: 'pair/example' }]));
      assert.deepEqual((await store.read())['pair/example'], { a: 'x', b: 'y' });
      await store.renew(lease, 90_000); await store.release(lease);
      const snapshot = await exportState(store);
      const destination = new SqliteStore(':memory:');
      try { await importState(destination, snapshot, config); assert.deepEqual(await destination.read(), await store.read()); await assert.rejects(importState(destination, snapshot, config), /stockage vide/); }
      finally { await destination.close(); }
      const reverse = factory();
      try { await importState(reverse, snapshot, config); assert.deepEqual(await reverse.read(), snapshot.records); }
      finally { await reverse.close(); }
    } finally { await store.close(); }
  });
  test(`${name}: une ancienne génération de verrou ne peut plus écrire`, async () => {
    const store = factory();
    try {
      const lease = await store.acquire(-1); assert.ok(lease);
      const next = await store.acquire(90_000); assert.ok(next);
      await assert.rejects(store.commit(lease, [{ key: 'bad', value: true }]), /lease_lost/);
      await store.release(lease); assert.equal(await store.acquire(1000), null);
      await store.release(next);
    } finally { await store.close(); }
  });
  test(`${name}: un import interrompu reste bloqué puis reprend le même fichier`, async () => {
    const store = factory(); const config = testConfig(); const commit = store.commit.bind(store);
    const snapshot = { format: 'calendar-sync-state', version: 1, exportedAt: new Date().toISOString(), records: { meta: { version: 1, identity: identity(config) }, ...Object.fromEntries(Array.from({ length: 401 }, (_, i) => [`ignore/A/${i}`, { reason: 'manual' }])) } };
    let calls = 0;
    store.commit = async (...args) => { if (++calls === 3) throw new Error('interruption'); await commit(...args); };
    try {
      await assert.rejects(importState(store, snapshot, config), /interruption/);
      assert.ok((await store.read()).importing); await assert.rejects(exportState(store), /import_incomplete/);
      store.commit = commit; await importState(store, snapshot, config); assert.deepEqual(await store.read(), snapshot.records);
    } finally { await store.close(); }
  });
}
