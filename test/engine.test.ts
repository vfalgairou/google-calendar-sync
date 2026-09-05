import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SyncEngine } from '../src/engine.js';
import { SqliteStore, FirestoreStore, type Store } from '../src/store.js';
import type { Conflict, Operation, Pair, Side } from '../src/types.js';
import { SyncError } from '../src/types.js';
import { event, FakeCalendar, testConfig } from './helpers.js';
import { exportState, importState } from '../src/state.js';

if (process.env.REQUIRE_FIRESTORE && !process.env.FIRESTORE_EMULATOR_HOST) throw new Error('FIRESTORE_EMULATOR_HOST requis.');
const backends = ['sqlite', ...(process.env.FIRESTORE_EMULATOR_HOST ? ['firestore'] : [])];
for (const backend of backends) {
  async function fixture(fn: (f: { engine: SyncEngine; api: FakeCalendar; store: Store; config: ReturnType<typeof testConfig>; pairs: () => Promise<Pair[]>; conflicts: () => Promise<Conflict[]> }) => Promise<void>) {
    const config = testConfig();
    const store = backend === 'sqlite' ? new SqliteStore(':memory:') : new FirestoreStore('calendar-sync-test', config.pairId);
    const api = new FakeCalendar(); const engine = new SyncEngine(config, store, api);
    try { await fn({ engine, api, store, config, pairs: async () => Object.entries(await store.read()).filter(([k]) => k.startsWith('pair/')).map(([, p]) => p as Pair), conflicts: async () => Object.entries(await store.read()).filter(([k]) => k.startsWith('conflict/')).map(([, c]) => c as Conflict) }); }
    finally { await store.close(); }
  }
  test(`${backend}: création dans les deux sens, convergence et édition depuis une copie`, () => fixture(async ({ engine, api, pairs }) => {
    api.put('A', event('a')); api.put('B', event('b'));
    assert.equal((await engine.run()).created, 2);
    const pair = (await pairs()).find(p => p.origin === 'A')!;
    api.edit('B', pair.b, { summary: 'modifié' });
    assert.equal((await engine.run()).updated, 1);
    assert.equal((await api.get('A', 'a'))!.summary, 'modifié');
    const writes = api.writes.length; await engine.run(); await engine.run(); assert.equal(api.writes.length, writes);
  }));
  test(`${backend}: suppression simple propagée sans résurrection`, () => fixture(async ({ engine, api, pairs }) => {
    api.put('A', event('a')); await engine.run(); const pair = (await pairs())[0]!;
    api.delete('B', pair.b); assert.equal((await engine.run()).deleted, 1);
    assert.equal((await api.get('A', pair.a))!.status, 'cancelled');
    await engine.run(); assert.equal(api.writes.filter(w => w.type === 'insert').length, 1);
  }));
  test(`${backend}: réunion organisée, notifications et masquage durable de copie`, () => fixture(async ({ engine, api, pairs }) => {
    api.put('A', event('meeting', { attendees: [{ email: 'guest@example.test' }], conferenceData: { conferenceId: 'kept' } }));
    await engine.run(); let pair = (await pairs())[0]!;
    const copy = await api.get('B', pair.b); assert.equal(copy!.attendees, undefined); assert.equal(copy!.conferenceData, undefined);
    api.edit('B', pair.b, { summary: 'nouveau titre' }); await engine.run();
    assert.equal(api.writes.at(-1)!.notify, true);
    assert.deepEqual((await api.get('A', 'meeting'))!.conferenceData, { conferenceId: 'kept' });
    assert.equal((await api.get('A', 'meeting'))!.attendees!.length, 1);
    const before = api.writes.length; await engine.run(); assert.equal(api.writes.length, before);
    api.delete('B', pair.b); await engine.run(); await engine.run();
    assert.equal(api.writes.length, before); assert.equal((await pairs())[0]!.suppressed, true);
    await engine.restoreCopy(pair.id); pair = (await pairs())[0]!; assert.equal(pair.generation, 1); assert.equal(pair.suppressed, false);
    api.delete('A', 'meeting'); await engine.run(); assert.equal((await api.get('B', pair.b))!.status, 'cancelled');
  }));
  test(`${backend}: invitation reçue, aucune modification de l'organisateur`, () => fixture(async ({ engine, api, pairs }) => {
    api.put('A', event('invitation', { organizer: { self: false, email: 'external@example.test' }, attendees: [{ self: true, responseStatus: 'accepted' }] }));
    await engine.run(); const pair = (await pairs())[0]!;
    api.edit('B', pair.b, { summary: 'tentative locale' }); await engine.run();
    assert.equal((await api.get('B', pair.b))!.summary, 'invitation');
    assert.equal(api.writes.filter(w => w.side === 'A').length, 0);
  }));
  test(`${backend}: conflits isolés, choix explicite et refus d'une résolution périmée`, () => fixture(async ({ engine, api, pairs, conflicts }) => {
    api.put('A', event('a')); api.put('A', event('autre')); await engine.run();
    const pair = (await pairs()).find(p => p.a === 'a')!;
    api.edit('A', 'a', { summary: 'A' }); api.edit('B', pair.b, { summary: 'B' });
    api.edit('A', 'autre', { summary: 'suite' }); await engine.run();
    assert.equal((await conflicts()).length, 1);
    assert.equal((await api.get('B', (await pairs()).find(p => p.a === 'autre')!.b))!.summary, 'suite');
    api.edit('A', 'a', { summary: 'A2' }); await assert.rejects(engine.resolve(pair.id, 'B'), /changé/);
    await engine.refreshConflicts(); await engine.resolve(pair.id, 'B');
    assert.equal((await api.get('A', 'a'))!.summary, 'B'); assert.equal((await conflicts()).length, 0);
  }));
  test(`${backend}: conflit suppression contre modification`, () => fixture(async ({ engine, api, pairs, conflicts }) => {
    api.put('A', event('a')); await engine.run(); const pair = (await pairs())[0]!;
    api.edit('A', 'a', { summary: 'changed' }); api.delete('B', pair.b); await engine.run();
    assert.equal((await conflicts())[0]!.kind, 'concurrent');
    await engine.resolve(pair.id, 'A'); assert.equal((await api.get('A', 'a'))!.status, 'confirmed');
    assert.equal((await api.get('B', (await pairs())[0]!.b))!.summary, 'changed');
  }));
  test(`${backend}: confidentialité sans écrasement du titre original et horaires bidirectionnels`, () => fixture(async ({ engine, api, pairs }) => {
    api.put('A', event('secret', { summary: 'confidentiel', description: 'détail secret', location: 'adresse', visibility: 'private' }));
    await engine.run(); const pair = (await pairs())[0]!;
    assert.equal((await api.get('B', pair.b))!.summary, 'Occupé');
    api.edit('B', pair.b, { summary: 'autre masque', start: { dateTime: '2030-10-24T12:00:00Z', timeZone: 'Europe/Paris' }, end: { dateTime: '2030-10-24T13:00:00Z', timeZone: 'Europe/Paris' } });
    await engine.run(); await engine.run();
    assert.equal((await api.get('A', 'secret'))!.summary, 'confidentiel');
    assert.equal((await api.get('A', 'secret'))!.description, 'détail secret');
    assert.match((await api.get('A', 'secret'))!.start!.dateTime!, /12:00/);
    assert.equal((await api.get('B', pair.b))!.summary, 'Occupé');
  }));
  test(`${backend}: passage public vers privé et journées entières`, () => fixture(async ({ engine, api, pairs }) => {
    api.put('A', event('day', { start: { date: '2030-03-30' }, end: { date: '2030-04-01' } }));
    await engine.run(); const pair = (await pairs())[0]!;
    api.edit('A', 'day', { visibility: 'private' }); await engine.run();
    const copy = await api.get('B', pair.b); assert.equal(copy!.summary, 'Occupé'); assert.deepEqual(copy!.end, { date: '2030-04-01' });
  }));
  test(`${backend}: panne après création ou modification, reprise sans doublon ni deuxième notification`, () => fixture(async ({ engine, api, pairs }) => {
    api.put('A', event('a', { attendees: [{ email: 'guest@example.test' }] })); api.failAfterWrite = true;
    await assert.rejects(engine.run(), /network_error/); await engine.run();
    assert.equal(api.writes.filter(w => w.type === 'insert').length, 1);
    const pair = (await pairs())[0]!; api.edit('B', pair.b, { summary: 'changement' }); api.failAfterWrite = true;
    await assert.rejects(engine.run()); await engine.run(); await engine.run();
    assert.equal(api.writes.filter(w => w.type === 'patch' && w.notify).length, 1);
  }));
  test(`${backend}: aperçu sans écriture ni curseur actif, lecture des deux côtés obligatoire`, () => fixture(async ({ engine, api, store }) => {
    api.put('A', event('a')); const before = await store.read();
    assert.equal((await engine.preview()).created, 1); assert.deepEqual(await store.read(), before); assert.equal(api.writes.length, 0);
    api.failListSide = 'B'; await assert.rejects(engine.run()); assert.equal(api.writes.length, 0);
    api.failListSide = undefined; await engine.run(); assert.equal(api.writes.length, 1);
  }));
  test(`${backend}: pagination et 410 préservent les associations et les copies masquées`, () => fixture(async ({ engine, api, pairs }) => {
    api.pageSize = 2; for (let i = 0; i < 5; i++) api.put('A', event(`item${i}`));
    await engine.run(); assert.equal((await pairs()).length, 5);
    const writes = api.writes.length; api.expired.add('A'); api.expired.add('B'); await engine.run();
    assert.equal((await pairs()).length, 5); assert.equal(api.writes.length, writes);
  }));
  test(`${backend}: disparition sans tombstone ne provoque aucune suppression`, () => fixture(async ({ engine, api, pairs, conflicts }) => {
    api.put('A', event('a')); await engine.run(); const pair = (await pairs())[0]!;
    api.events.A.delete('a'); api.expired.add('A'); await engine.run();
    assert.equal((await api.get('B', pair.b))!.status, 'confirmed'); assert.equal((await conflicts())[0]!.kind, 'missing');
  }));
  test(`${backend}: ETag protège la modification effectuée pendant l'écriture`, () => fixture(async ({ engine, api, pairs, conflicts }) => {
    api.put('A', event('a')); await engine.run(); const pair = (await pairs())[0]!;
    api.edit('A', 'a', { summary: 'source' }); api.beforePatch = (side, id) => { api.edit(side, id, { summary: 'concurrent' }); };
    await assert.rejects(engine.run()); await engine.run();
    assert.equal((await api.get('B', pair.b))!.summary, 'concurrent'); assert.equal((await conflicts()).length, 1);
  }));
  test(`${backend}: réunions natives non dupliquées, doublons ambigus qualifiés manuellement`, () => fixture(async ({ engine, api, conflicts }) => {
    api.put('A', event('nativeA', { iCalUID: 'native', attendees: [{ email: 'b@example.test' }] }));
    api.put('B', event('nativeB', { iCalUID: 'native', organizer: { email: 'a@example.test', self: false } }));
    api.put('A', event('dupeA', { summary: 'doublon' })); api.put('B', event('dupeB', { summary: 'doublon' }));
    await engine.run(); assert.equal(api.writes.length, 0); const conflict = (await conflicts())[0]!;
    assert.equal(conflict.kind, 'duplicate'); await engine.resolve(conflict.id, undefined, 'separate'); await engine.run();
    assert.equal(api.writes.filter(w => w.type === 'insert').length, 2);
  }));
  test(`${backend}: événements spéciaux et anciennes séries terminées exclus`, () => fixture(async ({ engine, api }) => {
    api.put('A', event('special', { eventType: 'fromGmail' }));
    api.put('A', event('old', { start: { date: '2020-01-01' }, end: { date: '2020-01-02' }, recurrence: ['RRULE:FREQ=DAILY;UNTIL=20201231'] }));
    api.put('A', event('active', { start: { date: '2020-01-01' }, end: { date: '2020-01-02' }, recurrence: ['RRULE:FREQ=WEEKLY'] }));
    await engine.run(); assert.equal(api.writes.length, 1); assert.deepEqual(api.writes[0]!.body!.start, { date: '2020-01-01' });
  }));
  test(`${backend}: occurrence modifiée depuis la copie et occurrence annulée à la source`, () => fixture(async ({ engine, api, pairs }) => {
    api.put('A', event('series', { recurrence: ['RRULE:FREQ=WEEKLY'], attendees: [{ email: 'guest@example.test' }] }));
    await engine.run(); const parent = (await pairs())[0]!;
    const start = { dateTime: '2030-10-31T11:00:00Z', timeZone: 'Europe/Paris' };
    const instB = await api.instance('B', parent.b, start); api.edit('B', instB!.id, { summary: 'exception modifiée' });
    await engine.run(); const instA = await api.instance('A', parent.a, start);
    assert.equal(instA!.summary, 'exception modifiée'); assert.equal(api.writes.at(-1)!.notify, true);
    api.delete('A', instA!.id); await engine.run(); assert.equal((await api.get('B', instB!.id))!.status, 'cancelled');
  }));
  test(`${backend}: scission sur copie de réunion bloque la série et les morceaux`, () => fixture(async ({ engine, api, pairs, conflicts }) => {
    api.put('A', event('series', { recurrence: ['RRULE:FREQ=WEEKLY'], attendees: [{ email: 'guest@example.test' }] }));
    await engine.run(); const pair = (await pairs())[0]!;
    api.edit('B', pair.b, { recurrence: ['RRULE:FREQ=WEEKLY;COUNT=3'] });
    api.put('B', event('new-piece', { recurrence: ['RRULE:FREQ=WEEKLY'] }));
    await engine.run(); assert.deepEqual((await api.get('A', 'series'))!.recurrence, ['RRULE:FREQ=WEEKLY']);
    assert.equal(api.writes.length, 1); assert.equal((await conflicts()).length, 2);
  }));
  test(`${backend}: deux premières exceptions concurrentes sont préservées`, () => fixture(async ({ engine, api, pairs, conflicts }) => {
    api.put('A', event('series', { recurrence: ['RRULE:FREQ=WEEKLY'] })); await engine.run();
    const parent = (await pairs())[0]!;
    const start = { dateTime: '2030-10-31T11:00:00Z', timeZone: 'Europe/Paris' };
    const a = (await api.instance('A', parent.a, start))!; const b = (await api.instance('B', parent.b, start))!;
    api.edit('A', a.id, { summary: 'exception A' }); api.edit('B', b.id, { summary: 'exception B' });
    await engine.run(); assert.equal((await conflicts()).length, 1);
    assert.equal((await api.get('A', a.id))!.summary, 'exception A'); assert.equal((await api.get('B', b.id))!.summary, 'exception B');
    await engine.resolve((await conflicts())[0]!.id, 'B'); assert.equal((await api.get('A', a.id))!.summary, 'exception B');
  }));
  test(`${backend}: restauration de série et de ses exceptions, masquage individuel conservé`, () => fixture(async ({ engine, api, pairs, conflicts }) => {
    api.put('A', event('series', { recurrence: ['RRULE:FREQ=WEEKLY'], attendees: [{ email: 'guest@example.test' }] })); await engine.run();
    let parent = (await pairs())[0]!;
    const first = { dateTime: '2030-10-31T11:00:00Z', timeZone: 'Europe/Paris' };
    const second = { dateTime: '2030-11-07T11:00:00Z', timeZone: 'Europe/Paris' };
    const a = (await api.instance('A', parent.a, first))!; api.edit('A', a.id, { summary: 'exception' });
    const b = (await api.instance('B', parent.b, second))!; api.delete('B', b.id); await engine.run();
    let hidden = (await pairs()).find(p => p.b === b.id)!; assert.equal(hidden.suppressed, true);
    await engine.restoreCopy(hidden.id); assert.equal((await api.get('B', b.id))!.status, 'confirmed');
    api.delete('B', b.id); await engine.run();
    api.delete('B', parent.b); await engine.run(); await engine.restoreCopy(parent.id); await engine.run();
    parent = (await pairs()).find(p => !p.parent)!; hidden = (await pairs()).find(p => p.id === hidden.id)!;
    assert.equal((await api.instance('B', parent.b, first))!.summary, 'exception');
    assert.equal((await api.instance('B', parent.b, second))!.status, 'cancelled');
    assert.equal(hidden.suppressed, true); assert.equal((await conflicts()).length, 0);
  }));
  test(`${backend}: choisir la copie survivante recrée un original simple sans perdre ses détails privés`, () => fixture(async ({ engine, api, pairs, conflicts }) => {
    api.put('A', event('a', { summary: 'secret original', visibility: 'private' })); await engine.run();
    const pair = (await pairs())[0]!; api.delete('A', 'a');
    api.edit('B', pair.b, { start: { dateTime: '2030-10-24T12:00:00Z', timeZone: 'Europe/Paris' }, end: { dateTime: '2030-10-24T13:00:00Z', timeZone: 'Europe/Paris' } });
    await engine.run(); assert.equal((await conflicts()).length, 1); await engine.resolve(pair.id, 'B');
    const restored = (await pairs())[0]!; const a = (await api.get('A', restored.a))!;
    assert.notEqual(restored.a, 'a'); assert.equal(a.summary, 'secret original'); assert.equal(a.visibility, 'private');
    assert.equal((await api.get('B', restored.b))!.summary, 'Occupé'); await engine.run(); assert.equal((await conflicts()).length, 0);
  }));
  test(`${backend}: une nouvelle modification après succès incertain n’est pas absorbée par la reprise`, () => fixture(async ({ engine, api, pairs }) => {
    api.put('A', event('a')); api.failAfterWrite = true; await assert.rejects(engine.run());
    api.edit('A', 'a', { summary: 'après coupure' }); await engine.run(); await engine.run();
    const pair = (await pairs())[0]!; assert.equal((await api.get('B', pair.b))!.summary, 'après coupure');
    assert.equal(api.writes.filter(w => w.type === 'insert').length, 1);
    api.edit('A', 'a', { summary: 'première édition' }); api.failAfterWrite = true; await assert.rejects(engine.run());
    api.edit('A', 'a', { summary: 'deuxième édition' }); await engine.run(); await engine.run();
    assert.equal((await api.get('B', pair.b))!.summary, 'deuxième édition');
  }));
  test(`${backend}: aperçu de série avec exception, puis transfert d’état sans nouvelle copie`, () => fixture(async ({ engine, api, store, config }) => {
    api.put('A', event('series', { recurrence: ['RRULE:FREQ=WEEKLY'] }));
    const a = (await api.instance('A', 'series', { dateTime: '2030-10-31T11:00:00Z', timeZone: 'Europe/Paris' }))!;
    api.edit('A', a.id, { summary: 'exception initiale' });
    const preview = await engine.preview(); assert.equal(preview.created, 1); assert.equal(preview.updated, 1); assert.equal(api.writes.length, 0);
    await engine.run(); const snapshot = await exportState(store); const dest = new SqliteStore(':memory:');
    try {
      await importState(dest, snapshot, config); const before = api.writes.length;
      await new SyncEngine(config, dest, api).run(); assert.equal(api.writes.length, before);
    } finally { await dest.close(); }
  }));
  test(`${backend}: passage borné reprend la pagination avant toute écriture`, () => fixture(async ({ engine, api, store, config, pairs }) => {
    api.pageSize = 1; for (let i = 0; i < 4; i++) api.put('A', event(`a${i}`));
    const list = api.list.bind(api); let calls = 0;
    api.list = async (...args) => { const result = await list(...args); if (++calls === 2) throw new SyncError('budget_exhausted'); return result; };
    assert.equal((await engine.run()).status, 'pending'); assert.equal(api.writes.length, 0);
    await new SyncEngine(config, store, api).run(); assert.equal((await pairs()).length, 4);
  }));
  test(`${backend}: révocation et perte de verrou arrêtent les effets sans suppression`, () => fixture(async ({ engine, api, store }) => {
    api.put('A', event('a')); const list = api.list.bind(api);
    api.list = async side => { if (side === 'B') throw new SyncError('auth_revoked'); return list(side, {}); };
    await assert.rejects(engine.run(), /auth_revoked/); assert.equal(api.writes.length, 0); api.list = list;
    const renew = store.renew.bind(store); let once = true;
    store.renew = async (lease, ttl) => { if (once) { once = false; await store.release(lease); } await renew(lease, ttl); };
    await assert.rejects(engine.run(), /lease_lost/); assert.equal(api.writes.length, 0); store.renew = renew;
    await engine.run(); assert.equal(api.writes.length, 1);
  }));
  test(`${backend}: deux moteurs partagent un verrou exclusif`, () => fixture(async ({ engine, api, store, config }) => {
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }); const blocked = new Promise<void>(resolve => { release = resolve; });
    const list = api.list.bind(api); api.list = async (...args) => { entered(); await blocked; return list(...args); };
    const first = engine.run(); await started;
    try { assert.equal((await new SyncEngine(config, store, api).run()).status, 'busy'); }
    finally { release(); await first; }
  }));
  test(`${backend}: limitation d’écriture conservée avec attente persistante et relecture`, () => fixture(async ({ engine, api, store }) => {
    api.put('A', event('a')); const insert = api.insert.bind(api); let attempts = 0;
    api.insert = async (...args) => { attempts++; if (attempts === 1) throw new SyncError('rate_limited', undefined, 429); return insert(...args); };
    await assert.rejects(engine.run(), /rate_limited/);
    assert.equal((await engine.run()).status, 'pending'); assert.equal(attempts, 1);
    assert.equal((await engine.preview()).status, 'pending'); assert.equal(attempts, 1);
    const [key, op] = Object.entries(await store.read()).find(([key]) => key.startsWith('op/'))!;
    const lease = (await store.acquire(90_000))!;
    await store.commit(lease, [{ key, value: { ...(op as Operation), nextAttemptAt: 0 } }]); await store.release(lease);
    assert.equal((await engine.run()).status, 'success'); assert.equal(attempts, 2); assert.equal(api.writes.length, 1);
  }));
}
