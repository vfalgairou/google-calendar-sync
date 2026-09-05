export type Side = 'A' | 'B';
export const sides: Side[] = ['A', 'B'];
export const other = (side: Side): Side => side === 'A' ? 'B' : 'A';
export interface EventTime { date?: string; dateTime?: string; timeZone?: string }
export interface CalendarEvent {
  id: string; etag: string; status?: string; eventType?: string;
  summary?: string; description?: string; location?: string;
  start?: EventTime; end?: EventTime; recurrence?: string[];
  recurringEventId?: string; originalStartTime?: EventTime;
  visibility?: string; transparency?: string; iCalUID?: string; htmlLink?: string;
  organizer?: { self?: boolean; email?: string };
  attendees?: { email?: string; self?: boolean; responseStatus?: string }[];
  extendedProperties?: { private?: Record<string, string>; shared?: Record<string, string> };
  reminders?: { useDefault: boolean; overrides?: unknown[] };
  [key: string]: unknown;
}
export interface Content {
  summary: string; description: string; location: string;
  start: EventTime; end: EventTime; recurrence: string[]; transparency: string;
}
export interface Page { items: CalendarEvent[]; nextPageToken?: string; nextSyncToken?: string }
export interface CalendarGateway {
  list(side: Side, query: { syncToken?: string; pageToken?: string }): Promise<Page>;
  get(side: Side, id: string): Promise<CalendarEvent | null>;
  insert(side: Side, event: Partial<CalendarEvent>): Promise<CalendarEvent>;
  patch(side: Side, id: string, etag: string, body: Partial<CalendarEvent>, notify: boolean): Promise<CalendarEvent>;
  remove(side: Side, id: string, etag: string): Promise<void>;
  instance(side: Side, masterId: string, originalStart: EventTime): Promise<CalendarEvent | null>;
  hasFutureInstance(side: Side, masterId: string, since: string): Promise<boolean>;
}
export interface Cached { event: CalendarEvent; generation?: string; missing?: boolean }
export interface Scan { syncToken?: string; pageToken?: string; generation?: string; full: boolean; ready: boolean }
export interface Meta {
  version: 1; identity: string; since: string;
  scans: Record<Side, Scan>; lastSuccess?: string; lastRun?: string;
  lastError?: string; lastReport?: Report;
}
export interface Pair {
  id: string; origin: Side; a: string; b: string;
  baselineA?: Content; baselineB?: Content;
  seenA?: string; seenB?: string;
  kind: 'simple' | 'organized' | 'received'; masked: boolean;
  suppressed?: boolean; deleted?: boolean; generation: number;
  parent?: string; parentGeneration?: number; conflict?: string;
}
export interface Conflict {
  id: string; kind: 'concurrent' | 'missing' | 'split' | 'unsafe' | 'duplicate' | 'orphan';
  pairId?: string; a?: string; b?: string; etagA?: string; etagB?: string;
  contentA?: Content; contentB?: Content; createdAt: string;
}
export interface Operation {
  id: string; pairId: string; type: 'insert' | 'patch' | 'delete';
  target: Side; targetId: string; expectedEtag?: string;
  source: Side; sourceId: string; sourceEtag: string;
  body?: Partial<CalendarEvent>; notify: boolean;
  sourceBaseline?: Content;
  suppression?: boolean;
  attempts?: number; nextAttemptAt?: number;
}
export interface Report {
  status: 'success' | 'pending' | 'busy' | 'error';
  created: number; updated: number; deleted: number; conflicts: number;
  excluded: number; scanned: number; durationMs: number;
  actions: { kind: string; pairId?: string; side?: Side }[];
}
export class SyncError extends Error {
  constructor(public code: string, message = code, public status?: number) { super(message); }
}
