import { createHash } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import type { CalendarEvent, Content, EventTime, Pair, Side } from './types.js';
import { SyncError } from './types.js';

// Firestore maps and Google responses need not retain JavaScript key order.
const canonical = (value: unknown): string | undefined => JSON.stringify(value, (_key, entry: unknown) => entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : entry);
export const hash = (value: unknown): string => createHash('sha256').update(canonical(value) ?? 'undefined').digest('hex');
export const clone = <T>(value: T): T => structuredClone(value);
export const equal = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
export const isDeleted = (e: CalendarEvent): boolean => e.status === 'cancelled';
export const isPrivate = (e: CalendarEvent): boolean => e.visibility === 'private' || e.visibility === 'confidential';
export function kindOf(e: CalendarEvent): Pair['kind'] {
  if (e.organizer && e.organizer.self !== true) return 'received';
  return e.attendees?.length ? 'organized' : 'simple';
}
export function timeKey(time?: EventTime): string {
  if (!time) return '';
  return time.date ?? (time.dateTime ? new Date(time.dateTime).toISOString() : '');
}
function time(t?: EventTime): EventTime {
  if (t?.date && !t.dateTime) return { date: t.date };
  if (t?.dateTime && !t.date) {
    // Keep the IANA zone, normalize only the representation of the instant.
    return { dateTime: new Date(t.dateTime).toISOString(), ...(t.timeZone ? { timeZone: t.timeZone } : {}) };
  }
  throw new SyncError('invalid_event_time');
}
export function content(e: CalendarEvent): Content {
  return {
    summary: e.summary ?? '', description: e.description ?? '', location: e.location ?? '',
    start: time(e.start), end: time(e.end), recurrence: [...(e.recurrence ?? [])].sort(),
    transparency: e.transparency ?? 'opaque',
  };
}
export function project(e: CalendarEvent): Content {
  const value = content(e);
  return isPrivate(e) ? { ...value, summary: 'Occupé', description: '', location: '' } : value;
}
export function toOriginal(copy: CalendarEvent, original: CalendarEvent): Content {
  const value = content(copy);
  return isPrivate(original) ? { ...value, summary: original.summary ?? '', description: original.description ?? '', location: original.location ?? '' } : value;
}
export function comparable(value: Content | undefined, masked: boolean): unknown {
  if (!value) return value;
  return masked ? { ...value, summary: '', description: '', location: '' } : value;
}
export function contentPatch(value: Content): Partial<CalendarEvent> {
  // Clearing recurrence uses an empty array; never replace unrelated event fields.
  return { ...value };
}
export function copyBody(e: CalendarEvent, id: string, pair: string, pairId: string): Partial<CalendarEvent> {
  return {
    ...contentPatch(project(e)), id,
    visibility: 'private', reminders: { useDefault: false, overrides: [] },
    extendedProperties: { private: { gcsPair: pair, gcsLink: pairId } },
    ...(e.htmlLink ? { source: { title: 'Événement original', url: e.htmlLink } } : {}),
  };
}
export const pairEventId = (pair: Pair, side: Side): string => side === 'A' ? pair.a : pair.b;
export const cacheKey = (side: Side, id: string): string => `event/${side}/${id}`;
export const pairKey = (id: string): string => `pair/${id}`;
export const sourceId = (pair: string, side: Side, event: string): string => hash([pair, side, event]);
export const copyId = (id: string, generation: number): string => `gcs${hash([id, generation])}`;

/** Reconstruct the pre-exception instance from the last synchronized master.
 * Use wall-clock duration in the series zone, including DST, not a fixed UTC offset.
 */
export function instanceBaseline(master: Content, originalStart: EventTime): Content {
  const value = clone(master); value.recurrence = [];
  if (master.start.date && master.end.date && originalStart.date) {
    const days = Temporal.PlainDate.from(master.start.date).until(Temporal.PlainDate.from(master.end.date)).days;
    value.start = { date: originalStart.date };
    value.end = { date: Temporal.PlainDate.from(originalStart.date).add({ days }).toString() };
  } else {
    const zone = master.start.timeZone ?? originalStart.timeZone ?? 'UTC';
    const start = Temporal.Instant.from(master.start.dateTime!).toZonedDateTimeISO(zone).toPlainDateTime();
    const end = Temporal.Instant.from(master.end.dateTime!).toZonedDateTimeISO(zone).toPlainDateTime();
    const duration = start.until(end, { largestUnit: 'days' });
    const occurrence = Temporal.Instant.from(originalStart.dateTime!).toZonedDateTimeISO(zone);
    value.start = time({ ...originalStart, timeZone: master.start.timeZone ?? originalStart.timeZone });
    value.end = { dateTime: new Date(occurrence.toPlainDateTime().add(duration).toZonedDateTime(zone).epochMilliseconds).toISOString(), ...(master.end.timeZone ? { timeZone: master.end.timeZone } : {}) };
  }
  return value;
}
