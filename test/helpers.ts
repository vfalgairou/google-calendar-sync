import { randomUUID } from 'node:crypto';
import { clone, hash, timeKey } from '../src/content.js';
import { configSchema } from '../src/config.js';
import type { CalendarEvent, CalendarGateway, EventTime, Page, Side } from '../src/types.js';
import { SyncError } from '../src/types.js';

export function testConfig() {
  return configSchema.parse({ pairId: `test-${randomUUID()}`, calendars: { A: { calendarId: 'a@example.test', credentialsFile: 'a.fake' }, B: { calendarId: 'b@example.test', credentialsFile: 'b.fake' } }, storage: { type: 'sqlite', path: ':memory:' }, allowWrites: true, runBudgetSeconds: 240 });
}
export function event(id: string, extra: Partial<CalendarEvent> = {}): CalendarEvent {
  return { id, etag: 'initial', summary: id, description: '', location: '', start: { dateTime: '2030-10-24T10:00:00Z', timeZone: 'Europe/Paris' }, end: { dateTime: '2030-10-24T11:00:00Z', timeZone: 'Europe/Paris' }, organizer: { self: true, email: 'a@example.test' }, iCalUID: `${id}@test`, status: 'confirmed', ...extra };
}
export class FakeCalendar implements CalendarGateway {
  events: Record<Side, Map<string, CalendarEvent>> = { A: new Map(), B: new Map() };
  revision = 0;
  changes: Record<Side, Map<string, number>> = { A: new Map(), B: new Map() };
  generated = new Set<string>();
  writes: { type: string; side: Side; id: string; notify?: boolean; body?: Partial<CalendarEvent> }[] = [];
  pageSize = 200; expired = new Set<Side>();
  failAfterWrite = false;
  failListSide?: Side;
  beforePatch?: (side: Side, id: string) => void;
  put(side: Side, e: CalendarEvent): CalendarEvent {
    const value = { ...clone(e), etag: `v${++this.revision}` };
    this.events[side].set(e.id, value); this.changes[side].set(e.id, this.revision);
    return clone(value);
  }
  edit(side: Side, id: string, patch: Partial<CalendarEvent>): CalendarEvent {
    this.generated.delete(`${side}:${id}`);
    return this.put(side, { ...this.events[side].get(id)!, ...clone(patch) });
  }
  delete(side: Side, id: string): void { this.edit(side, id, { status: 'cancelled' }); }
  async list(side: Side, query: { syncToken?: string; pageToken?: string }): Promise<Page> {
    if (this.failListSide === side) throw new SyncError('access_denied', undefined, 403);
    if (query.syncToken && this.expired.delete(side)) throw new SyncError('gone', undefined, 410);
    const [from, to, offset] = query.pageToken ? query.pageToken.split(':').map(Number) : [query.syncToken ? Number(query.syncToken) : -1, this.revision, 0];
    const entries = [...this.events[side].values()].filter(e => !this.generated.has(`${side}:${e.id}`) && this.changes[side].get(e.id)! > from! && this.changes[side].get(e.id)! <= to!);
    const items = entries.slice(offset!, offset! + this.pageSize);
    return clone({ items, ...(offset! + this.pageSize < entries.length ? { nextPageToken: `${from}:${to}:${offset! + this.pageSize}` } : { nextSyncToken: String(to) }) });
  }
  async get(side: Side, id: string): Promise<CalendarEvent | null> { return clone(this.events[side].get(id) ?? null); }
  async insert(side: Side, body: Partial<CalendarEvent>): Promise<CalendarEvent> {
    if (this.events[side].has(body.id!)) throw new SyncError('already_exists', undefined, 409);
    const value = this.put(side, event(body.id!, { ...body, organizer: { self: true, email: `${side.toLowerCase()}@example.test` } }));
    this.writes.push({ type: 'insert', side, id: body.id!, body: clone(body) });
    if (this.failAfterWrite) { this.failAfterWrite = false; throw new SyncError('network_error'); }
    return value;
  }
  async patch(side: Side, id: string, etag: string, body: Partial<CalendarEvent>, notify: boolean): Promise<CalendarEvent> {
    const hook = this.beforePatch; this.beforePatch = undefined; hook?.(side, id);
    if (this.events[side].get(id)?.etag !== etag) throw new SyncError('precondition_failed', undefined, 412);
    const value = this.edit(side, id, body); this.writes.push({ type: 'patch', side, id, notify, body: clone(body) });
    if (this.failAfterWrite) { this.failAfterWrite = false; throw new SyncError('network_error'); }
    return value;
  }
  async remove(side: Side, id: string, etag: string): Promise<void> {
    if (this.events[side].get(id)?.etag !== etag) throw new SyncError('precondition_failed', undefined, 412);
    this.delete(side, id); this.writes.push({ type: 'delete', side, id });
    if (this.failAfterWrite) { this.failAfterWrite = false; throw new SyncError('network_error'); }
  }
  async instance(side: Side, masterId: string, start: EventTime): Promise<CalendarEvent | null> {
    const found = [...this.events[side].values()].find(e => e.recurringEventId === masterId && timeKey(e.originalStartTime) === timeKey(start));
    if (found) return clone(found);
    const master = this.events[side].get(masterId); if (!master || master.status === 'cancelled') return null;
    const duration = Date.parse(master.end?.dateTime ?? `${master.end?.date}T00:00:00Z`) - Date.parse(master.start?.dateTime ?? `${master.start?.date}T00:00:00Z`);
    const instant = Date.parse(start.dateTime ?? `${start.date}T00:00:00Z`);
    const end: EventTime = start.date ? { date: new Date(instant + duration).toISOString().slice(0, 10) } : { dateTime: new Date(instant + duration).toISOString(), timeZone: start.timeZone };
    const instance = this.put(side, { ...clone(master), recurrence: undefined, id: `${masterId}_${hash(start).slice(0, 16)}`, recurringEventId: masterId, originalStartTime: start, start, end });
    this.generated.add(`${side}:${instance.id}`); return instance;
  }
  async hasFutureInstance(side: Side, id: string, since: string): Promise<boolean> {
    const e = this.events[side].get(id)!;
    const until = e.recurrence?.join(';').match(/UNTIL=(\d{8})/)?.[1];
    return !until || until >= since.slice(0, 10).replaceAll('-', '');
  }
}
