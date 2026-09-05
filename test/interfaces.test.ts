import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OAuth2Client } from 'google-auth-library';
import { GoogleCalendar, sanitizedError } from '../src/google.js';
import { createSyncServer } from '../src/server.js';
import type { SyncEngine } from '../src/engine.js';
import { testConfig, event } from './helpers.js';
import { content, equal, hash, instanceBaseline } from '../src/content.js';

test('Google HTTP: scopes de calendrier explicites, cursors compatibles et écritures conditionnelles', async () => {
  const requests: Record<string, unknown>[] = [];
  const client = { request: async (options: Record<string, unknown>) => { requests.push(options); return { data: event('e') }; } } as unknown as OAuth2Client;
  const api = new GoogleCalendar(testConfig(), { A: client, B: client });
  await api.list('A', { syncToken: 'token', pageToken: 'page' });
  const params = requests[0]!.params as Record<string, unknown>;
  assert.equal(params.syncToken, 'token'); assert.equal(params.showDeleted, true); assert.equal(params.singleEvents, false);
  assert.equal(params.timeMin, undefined); assert.equal(params.privateExtendedProperty, undefined);
  await api.patch('A', 'event/id', 'etag', { summary: 'changed' }, true);
  assert.deepEqual(requests[1]!.headers, { 'If-Match': 'etag' });
  assert.deepEqual(requests[1]!.params, { sendUpdates: 'all' });
  assert.match(String(requests[1]!.url), /a%40example.test\/events\/event%2Fid$/);
  assert.equal(requests[1]!.retry, false);
  await assert.rejects(api.insert('B', { attendees: [{ email: 'guest@example.test' }] }), /forbidden/);
});
test('normalisation conserve les instants et le fuseau au changement d’heure', () => {
  const c = content(event('dst', { start: { dateTime: '2030-10-27T02:30:00+02:00', timeZone: 'Europe/Paris' }, end: { dateTime: '2030-10-27T02:30:00+01:00', timeZone: 'Europe/Paris' } }));
  assert.equal(c.start.dateTime, '2030-10-27T00:30:00.000Z'); assert.equal(c.end.dateTime, '2030-10-27T01:30:00.000Z'); assert.equal(c.start.timeZone, 'Europe/Paris');
});
test('comparaisons et identifiants indépendants de l’ordre des clés Firestore', () => {
  assert.equal(equal({ b: { d: 1, c: 2 }, a: 3 }, { a: 3, b: { c: 2, d: 1 } }), true);
  assert.equal(hash({ dateTime: '2030-01-01T12:00:00Z', timeZone: 'Europe/Paris' }), hash({ timeZone: 'Europe/Paris', dateTime: '2030-01-01T12:00:00Z' }));
});
test('baseline d’occurrence conserve la durée calendaire au passage d’heure d’été', () => {
  const baseline = content(event('series', { start: { dateTime: '2030-03-23T12:00:00+01:00', timeZone: 'Europe/Paris' }, end: { dateTime: '2030-03-24T12:00:00+01:00', timeZone: 'Europe/Paris' } }));
  const instance = instanceBaseline(baseline, { dateTime: '2030-03-30T12:00:00+01:00' });
  assert.equal(instance.start.timeZone, 'Europe/Paris');
  assert.equal(instance.end.dateTime, '2030-03-31T10:00:00.000Z');
});
test('erreurs Google expurgées sans jeton ni contenu dans les messages', () => {
  const error = { message: 'SECRET', response: { status: 400, data: { error: 'invalid_grant', description: 'SECRET' } }, config: { headers: { Authorization: 'Bearer SECRET' } } };
  const safe = sanitizedError(error);
  assert.equal(safe.code, 'auth_revoked'); assert.ok(!JSON.stringify(safe).includes('SECRET')); assert.ok(!safe.message.includes('SECRET'));
});
test('HTTP attend la fin du passage, refuse les corps et évite les exécutions simultanées', async () => {
  let finish!: () => void; let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const wait = new Promise<void>(resolve => { finish = resolve; });
  const engine = { run: async () => { started(); await wait; return { status: 'success', actions: [{ kind: 'sensitive_action' }] }; } } as unknown as SyncEngine;
  const server = createSyncServer(engine); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${url}/healthz`)).status, 200);
    assert.equal((await fetch(`${url}/sync`, { method: 'POST', body: '{}' })).status, 400);
    const first = fetch(`${url}/sync`, { method: 'POST' }); await entered;
    assert.deepEqual(await (await fetch(`${url}/sync`, { method: 'POST' })).json(), { status: 'busy' });
    finish(); assert.deepEqual(await (await first).json(), { status: 'success' });
  } finally { finish(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
