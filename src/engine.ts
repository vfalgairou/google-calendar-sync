import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import { identity } from './config.js';
import { cacheKey, clone, comparable, content, contentPatch, copyBody, copyId, equal, hash, instanceBaseline, isDeleted, isPrivate, kindOf, pairEventId, pairKey, project, sourceId, timeKey, toOriginal } from './content.js';
import { MemoryStore, Repository, type Store } from './store.js';
import { sanitizedError } from './google.js';
import { other, sides, SyncError, type Cached, type CalendarEvent, type CalendarGateway, type Conflict, type Content, type Meta, type Operation, type Pair, type Report, type Side } from './types.js';

type Logger = (record: Record<string, unknown>) => void;
const ttl = 90_000;
const emptyReport = (): Report => ({ status: 'pending', created: 0, updated: 0, deleted: 0, conflicts: 0, excluded: 0, scanned: 0, durationMs: 0, actions: [] });

export class SyncEngine {
  private repo!: Repository;
  private report = emptyReport();
  private deadline = 0;
  private lost = false;
  constructor(private config: Config, private store: Store, private api: CalendarGateway, private log: Logger = () => {}) {}

  private async gate(): Promise<void> {
    if (this.lost) throw new SyncError('lease_lost');
    if (Date.now() >= this.deadline) throw new SyncError('budget_exhausted');
    await this.store.renew(this.repo.lease, ttl);
  }
  private meta(): Meta { return this.repo.get<Meta>('meta')!; }
  private async saveMeta(meta: Meta): Promise<void> { await this.repo.put([{ key: 'meta', value: meta }]); }
  private cached(side: Side, id: string): Cached | undefined { return this.repo.get<Cached>(cacheKey(side, id)); }
  private async cache(side: Side, event: CalendarEvent): Promise<void> {
    await this.repo.put([{ key: cacheKey(side, event.id), value: { event, generation: this.meta().scans[side].generation } }]);
  }
  private action(kind: string, pair?: Pair, side?: Side): void {
    this.report.actions.push({ kind, ...(pair ? { pairId: pair.id } : {}), ...(side ? { side } : {}) });
  }
  async run(): Promise<Report> {
    if (!this.config.allowWrites) throw new SyncError('writes_disabled', 'Écritures désactivées : utiliser preview puis activer allowWrites dans la configuration.');
    const start = Date.now();
    this.report = emptyReport(); this.lost = false;
    const lease = await this.store.acquire(ttl);
    if (!lease) return { ...this.report, status: 'busy' };
    this.deadline = start + this.config.runBudgetSeconds * 1000;
    let heartbeat: Promise<void> = Promise.resolve();
    const timer = setInterval(() => {
      heartbeat = heartbeat.then(() => this.store.renew(lease, ttl)).catch(() => { this.lost = true; });
    }, 20_000);
    try {
      this.repo = new Repository(this.store, lease, await this.store.read());
      if (this.repo.get('importing')) throw new SyncError('import_incomplete');
      if (!this.repo.get('meta')) await this.saveMeta({ version: 1, identity: identity(this.config), since: new Date(start - 30 * 86_400_000).toISOString(), scans: { A: { full: true, ready: false }, B: { full: true, ready: false } } });
      if (this.meta().version !== 1 || this.meta().identity !== identity(this.config)) throw new SyncError('state_identity_mismatch', 'Cet état appartient à une autre paire de calendriers.');
      await this.scan('A');
      await this.scan('B');
      await this.markMissing();
      // Both sides have been durably ingested before any Calendar write.
      for (const [, op] of this.repo.list<Operation>('op/')) { await this.gate(); await this.execute(op); }
      await this.detectSplit();
      for (const [, pair] of this.repo.list<Pair>('pair/')) await this.reconcile(pair);
      await this.discover(false);
      await this.discover(true);
      const meta = this.meta();
      meta.scans.A.ready = false; meta.scans.B.ready = false;
      this.report.status = this.repo.list<Operation>('op/').length ? 'pending' : 'success';
      if (this.report.status === 'success') { meta.lastSuccess = new Date().toISOString(); delete meta.lastError; }
      await this.saveMeta(meta);
      return this.report;
    } catch (error) {
      const safe = sanitizedError(error);
      this.report.status = safe.code === 'budget_exhausted' ? 'pending' : 'error';
      if (safe.code !== 'budget_exhausted') {
        this.log({ severity: 'ERROR', event: safe.code, pair: this.config.pairId });
        if (this.repo && !this.lost && this.meta()?.identity === identity(this.config)) {
          const meta = this.meta(); meta.lastError = safe.code;
          await this.saveMeta(meta).catch(() => {});
        }
        throw safe;
      }
      return this.report;
    } finally {
      clearInterval(timer); await heartbeat;
      this.report.durationMs = Date.now() - start;
      if (this.repo && !this.lost && this.meta()?.identity === identity(this.config)) {
        const meta = this.meta(); meta.lastRun = new Date().toISOString(); meta.lastReport = this.report;
        await this.saveMeta(meta).catch(() => {});
      }
      // Only counters and opaque pair IDs are logged, never event bodies/errors.
      const { actions: _, ...counters } = this.report;
      this.log({ severity: this.report.status === 'error' ? 'ERROR' : 'INFO', event: this.report.status === 'success' ? 'sync_success' : 'sync_pass', pair: this.config.pairId, ...counters });
      await this.store.release(lease);
    }
  }

  private async scan(side: Side): Promise<void> {
    while (!this.meta().scans[side].ready) {
      await this.gate();
      const meta = this.meta(); const scan = meta.scans[side];
      if (scan.full && !scan.generation) scan.generation = randomUUID();
      let page;
      try { page = await this.api.list(side, { ...(scan.full ? {} : { syncToken: scan.syncToken }), ...(scan.pageToken ? { pageToken: scan.pageToken } : {}) }); }
      catch (e) {
        if (e instanceof SyncError && (e.status === 410 || e.code === 'gone')) {
          meta.scans[side] = { full: true, ready: false, generation: randomUUID() };
          await this.saveMeta(meta); continue;
        }
        // A Google page token may become invalid during a long initial import.
        if (e instanceof SyncError && e.status === 400 && scan.pageToken) {
          delete scan.pageToken; if (scan.full) scan.generation = randomUUID();
          await this.saveMeta(meta); throw new SyncError('pagination_restart');
        }
        throw e;
      }
      if (!page.nextPageToken && !page.nextSyncToken) throw new SyncError('incomplete_calendar_page');
      if (page.items.length > 200) throw new SyncError('unexpected_page_size');
      scan.pageToken = page.nextPageToken;
      if (!page.nextPageToken) { scan.ready = true; scan.syncToken = page.nextSyncToken; }
      await this.repo.put([
        ...page.items.map(event => ({ key: cacheKey(side, event.id), value: { event, generation: scan.generation } })),
        { key: 'meta', value: meta },
      ]);
      this.report.scanned += page.items.length;
    }
  }
  private async markMissing(): Promise<void> {
    for (const side of sides) {
      const meta = this.meta(); const scan = meta.scans[side];
      if (!scan.full) continue;
      const missing = this.repo.list<Cached>(`event/${side}/`).filter(([, v]) => v.generation !== scan.generation);
      for (let i = 0; i < missing.length; i += 200) {
        await this.gate();
        await this.repo.put(missing.slice(i, i + 200).map(([key, v]) => ({ key, value: { ...v, missing: true } })));
      }
      scan.full = false; await this.saveMeta(meta);
    }
  }

  private async conflict(kind: Conflict['kind'], pair?: Pair, a?: CalendarEvent | null, b?: CalendarEvent | null): Promise<void> {
    const id = pair?.id ?? hash([kind, a?.id, b?.id]);
    const key = `conflict/${id}`;
    const previous = this.repo.get<Conflict>(key);
    const value: Conflict = { id, kind, createdAt: previous?.createdAt ?? new Date().toISOString(),
      ...(pair ? { pairId: pair.id } : {}),
      ...(a ? { a: a.id, etagA: a.etag, ...(!isDeleted(a) && a.start && a.end ? { contentA: content(a) } : {}) } : {}),
      ...(b ? { b: b.id, etagB: b.etag, ...(!isDeleted(b) && b.start && b.end ? { contentB: content(b) } : {}) } : {}),
    };
    const changes = [{ key, value: value as unknown }];
    if (pair) { pair.conflict = id; changes.push({ key: pairKey(pair.id), value: pair }); }
    await this.repo.put(changes);
    if (!previous) {
      this.report.conflicts++; this.action(`conflict:${kind}`, pair);
      this.log({ severity: 'WARNING', event: 'new_conflict', pair: this.config.pairId, conflictId: id, kind });
    }
  }
  private async checkpoint(pair: Pair, a: CalendarEvent, b: CalendarEvent): Promise<void> {
    pair.seenA = a.etag; pair.seenB = b.etag;
    if (!isDeleted(a)) pair.baselineA = content(a);
    if (!isDeleted(b)) pair.baselineB = content(b);
    delete pair.conflict;
    await this.repo.put([{ key: pairKey(pair.id), value: pair }, { key: `conflict/${pair.id}` }]);
  }
  private async readPair(pair: Pair): Promise<[CalendarEvent | null, CalendarEvent | null]> {
    await this.gate(); const a = await this.api.get('A', pair.a);
    await this.gate(); const b = await this.api.get('B', pair.b);
    if (a) await this.cache('A', a);
    if (b) await this.cache('B', b);
    return [a, b];
  }
  private async detectSplit(): Promise<void> {
    for (const [, pair] of this.repo.list<Pair>('pair/')) {
      if (pair.kind === 'simple' || pair.parent || pair.deleted || pair.suppressed) continue;
      const mirrorSide = other(pair.origin);
      const mirror = this.cached(mirrorSide, pairEventId(pair, mirrorSide))?.event;
      const baseline = mirrorSide === 'A' ? pair.baselineA : pair.baselineB;
      // Structural recurrence edits on a meeting's mirror are conservatively reviewed.
      if (mirror && !isDeleted(mirror) && baseline?.recurrence.length && !equal(content(mirror).recurrence, baseline.recurrence)) {
        const [a, b] = await this.readPair(pair);
        await this.conflict('split', pair, a, b);
        await this.repo.put([{ key: `split/${mirrorSide}`, value: { pairId: pair.id } }]);
      }
    }
  }

  private async reconcile(pair: Pair, choice?: Side): Promise<void> {
    if (this.repo.list<Operation>('op/').some(([, op]) => op.pairId === pair.id)) return;
    if (pair.parent) {
      const parent = this.repo.get<Pair>(pairKey(pair.parent));
      if (!parent || parent.suppressed || parent.deleted || parent.conflict) return;
      if ((pair.parentGeneration ?? 0) !== parent.generation) {
        await this.rebindInstance(pair, parent); return;
      }
    }
    if (pair.deleted) return;
    const ca = this.cached('A', pair.a); const cb = this.cached('B', pair.b);
    if (!choice && pair.seenA === ca?.event.etag && pair.seenB === cb?.event.etag && !ca?.missing && !cb?.missing) return;
    if (!choice && pair.conflict) return;
    const [a, b] = await this.readPair(pair);
    const origin = pair.origin === 'A' ? a : b;
    const mirror = pair.origin === 'A' ? b : a;
    if (!origin) { await this.conflict('missing', pair, a, b); return; }
    // A received invitation remains a meeting even if its attendee list was omitted.
    if (!isDeleted(origin)) { pair.kind = kindOf(origin); pair.masked = isPrivate(origin); }
    if (pair.suppressed) {
      if (isDeleted(origin)) pair.deleted = true;
      pair.seenA = a?.etag; pair.seenB = b?.etag;
      await this.repo.put([{ key: pairKey(pair.id), value: pair }]); return;
    }
    if (!a || !b) { await this.conflict('missing', pair, a, b); return; }
    if (mirror && !isDeleted(mirror) && (mirror.attendees?.length || mirror.conferenceData)) {
      await this.conflict('unsafe', pair, a, b); return;
    }
    if (isDeleted(a) && isDeleted(b)) { pair.deleted = true; await this.checkpoint(pair, a, b); return; }
    if (isDeleted(a) || isDeleted(b)) {
      const deletedSide: Side = isDeleted(a) ? 'A' : 'B';
      if (deletedSide !== pair.origin && pair.kind !== 'simple') {
        pair.suppressed = true; await this.checkpoint(pair, a, b); this.action('hide_copy', pair, deletedSide); return;
      }
      const survivor = deletedSide === 'A' ? b : a;
      const baseline = deletedSide === 'A' ? pair.baselineB : pair.baselineA;
      if (!choice && !equal(comparable(content(survivor), pair.masked), comparable(baseline, pair.masked))) {
        await this.conflict('concurrent', pair, a, b); return;
      }
      if (choice && choice !== deletedSide) {
        if (deletedSide === pair.origin) {
          if (pair.kind !== 'simple') throw new SyncError('restore_original_in_google', 'Restaurer cet original dans Google Calendar, puis relancer la synchronisation.');
          await this.restoreSimpleOriginal(pair, survivor, origin); return;
        }
        await this.recreateCopy(pair, origin); return;
      }
      const target = other(deletedSide);
      // Deleting an original with guests is never authorized by a mirror tombstone.
      if (target === pair.origin && pair.kind !== 'simple') throw new SyncError('meeting_cancellation_forbidden');
      await this.planOperation(pair, { type: 'delete', target, targetId: survivor.id, expectedEtag: survivor.etag, source: deletedSide, sourceId: pairEventId(pair, deletedSide), sourceEtag: (deletedSide === 'A' ? a : b).etag, notify: false });
      return;
    }
    const changedA = !equal(comparable(content(a), pair.masked), comparable(pair.baselineA, pair.masked));
    const changedB = !equal(comparable(content(b), pair.masked), comparable(pair.baselineB, pair.masked));
    if (!choice && pair.kind !== 'received' && changedA && changedB && !equal(comparable(content(a), pair.masked), comparable(content(b), pair.masked))) {
      await this.conflict('concurrent', pair, a, b); return;
    }
    const mirrorSide = other(pair.origin);
    let winner = choice ?? (changedA && !changedB ? 'A' : changedB && !changedA ? 'B' : pair.origin);
    if (pair.kind === 'received') winner = pair.origin;
    if (choice && pair.kind === 'received' && choice !== pair.origin) throw new SyncError('received_event_readonly');
    const source = winner === 'A' ? a : b; const targetSide = other(winner); const target = targetSide === 'A' ? a : b;
    const desired = winner === pair.origin ? project(source) : toOriginal(source, target);
    // A privacy change can require redaction even when temporal content is unchanged.
    if (!equal(content(target), desired)) {
      const patch = contentPatch(desired);
      if (target.recurringEventId) delete patch.recurrence;
      if (targetSide === mirrorSide) patch.visibility = 'private';
      await this.planOperation(pair, { type: 'patch', target: targetSide, targetId: target.id, expectedEtag: target.etag, source: winner, sourceId: source.id, sourceEtag: source.etag, body: patch, notify: targetSide === pair.origin && pair.kind === 'organized' });
    } else {
      // Always enforce masking on the mirror even when a masked field was edited there.
      const expectedMirror = project(origin);
      if (pair.masked && mirror && !equal(content(mirror), expectedMirror) && winner === mirrorSide) {
        const body = contentPatch(expectedMirror); if (mirror.recurringEventId) delete body.recurrence;
        await this.planOperation(pair, { type: 'patch', target: mirrorSide, targetId: mirror.id, expectedEtag: mirror.etag, source: pair.origin, sourceId: origin.id, sourceEtag: origin.etag, body, notify: false });
      } else await this.checkpoint(pair, a, b);
    }
  }

  private async planOperation(pair: Pair, value: Omit<Operation, 'id' | 'pairId'>): Promise<void> {
    const cachedSource = this.cached(value.source, value.sourceId)?.event;
    const op: Operation = { ...value, ...(cachedSource && !isDeleted(cachedSource) ? { sourceBaseline: content(cachedSource) } : {}), id: hash([pair.id, value.type, value.targetId, value.sourceEtag, value.expectedEtag]), pairId: pair.id };
    await this.repo.put([{ key: pairKey(pair.id), value: pair }, { key: `op/${op.id}`, value: op }]);
    await this.execute(op);
  }
  private async execute(op: Operation): Promise<void> {
    await this.gate();
    const pair = this.repo.get<Pair>(pairKey(op.pairId));
    if (!pair) throw new SyncError('operation_pair_missing');
    const source = await this.api.get(op.source, op.sourceId);
    await this.gate(); const target = await this.api.get(op.target, op.targetId);
    let result = target;
    const hasEffect = op.type === 'delete' ? (target === null || isDeleted(target)) : !!target && !isDeleted(target) && (op.type === 'insert' ? target.extendedProperties?.private?.gcsLink === pair.id && target.extendedProperties?.private?.gcsPair === this.config.pairId : equal(content(target), content({ ...target, ...op.body })) && ['visibility', 'status'].every(key => !(key in (op.body ?? {})) || equal(target[key], op.body![key])));
    if (!hasEffect) {
      if (!source || source.etag !== op.sourceEtag) {
        if (source) await this.cache(op.source, source);
        if (target) await this.cache(op.target, target);
        await this.repo.put([{ key: `op/${op.id}` }]);
        // New pairs must stay eligible for recovery when their source changed before insertion.
        if (op.type === 'insert' && source && !isDeleted(source) && !target) {
          const body = op.target === pair.origin ? { ...op.body, ...contentPatch(toOriginal(source, { ...op.body, id: op.targetId, etag: '' } as CalendarEvent)) } : copyBody(source, op.targetId, this.config.pairId, pair.id);
          await this.planOperation(pair, { ...op, sourceEtag: source.etag, body });
        } else if (!source || (op.type === 'insert' && target)) {
          await this.conflict('missing', pair, op.source === 'A' ? source : target, op.source === 'B' ? source : target);
        } else if (op.type === 'insert' && source && isDeleted(source)) {
          pair.deleted = true; await this.repo.put([{ key: pairKey(pair.id), value: pair }]);
        }
        return;
      }
      if (op.type !== 'insert' && (!target || target.etag !== op.expectedEtag)) {
        if (target) await this.cache(op.target, target);
        await this.repo.put([{ key: `op/${op.id}` }]);
        await this.conflict(target ? 'concurrent' : 'missing', pair, op.source === 'A' ? source : target, op.source === 'B' ? source : target); return;
      }
      if (op.type === 'insert' && target) { await this.conflict('unsafe', pair, op.target === 'A' ? target : source, op.target === 'B' ? target : source); await this.repo.put([{ key: `op/${op.id}` }]); return; }
      // Still verify an uncertain result while backing off, but do not repeat its write.
      if ((op.nextAttemptAt ?? 0) > Date.now()) return;
      await this.gate();
      try {
        if (op.type === 'insert') result = await this.api.insert(op.target, op.body!);
        else if (op.type === 'patch') result = await this.api.patch(op.target, op.targetId, op.expectedEtag!, op.body!, op.notify);
        else { await this.api.remove(op.target, op.targetId, op.expectedEtag!); result = { id: op.targetId, etag: op.expectedEtag!, status: 'cancelled' }; }
      } catch (e) {
        if (e instanceof SyncError && ['rate_limited', 'google_unavailable'].includes(e.code)) {
          op.attempts = (op.attempts ?? 0) + 1;
          op.nextAttemptAt = Date.now() + Math.min(1_800_000, 120_000 * 2 ** Math.min(op.attempts - 1, 4)) + Math.floor(Math.random() * 1000);
          await this.repo.put([{ key: `op/${op.id}`, value: op }]);
        }
        if (e instanceof SyncError && [409, 412].includes(e.status ?? 0)) {
          // Keep the journal: next pass rereads both resources before deciding.
          throw new SyncError('operation_recheck');
        }
        throw e;
      }
      if (op.type === 'insert') this.report.created++;
      if (op.type === 'patch') this.report.updated++;
      if (op.type === 'delete') this.report.deleted++;
      this.action(op.type, pair, op.target);
    }
    if (source) await this.cache(op.source, source);
    if (result) await this.cache(op.target, result);
    if (op.type === 'delete') {
      if (op.suppression) pair.suppressed = true; else pair.deleted = true;
    }
    // Baseline the exact source version used for the operation. If the source changed
    // after an uncertain success, leave its old checkpoint so the new change survives.
    if (source && result && op.type !== 'delete' && op.sourceBaseline) {
      const expected = content(hasEffect ? { ...result, ...op.body } as CalendarEvent : result);
      const actualMatches = equal(content(result), expected);
      pair.seenA = op.source === 'A' ? op.sourceEtag : actualMatches ? result.etag : undefined;
      pair.seenB = op.source === 'B' ? op.sourceEtag : actualMatches ? result.etag : undefined;
      pair.baselineA = op.source === 'A' ? op.sourceBaseline : expected;
      pair.baselineB = op.source === 'B' ? op.sourceBaseline : expected;
      const original = pair.origin === op.source ? source : result;
      const mirror = pair.origin === op.source ? result : source;
      pair.kind = kindOf(original); pair.masked = isPrivate(original);
      if (pair.masked && !isDeleted(original) && !isDeleted(mirror) && !equal(project(original), content(mirror))) {
        if (pair.origin === 'A') pair.seenB = undefined; else pair.seenA = undefined;
      }
      delete pair.conflict;
    }
    await this.repo.put([{ key: pairKey(pair.id), value: pair }, { key: `op/${op.id}` }, { key: `conflict/${pair.id}` }]);
    if (op.type === 'delete' && !op.suppression && source && !isDeleted(source)) {
      pair.deleted = false;
      await this.conflict('concurrent', pair, op.source === 'A' ? source : result, op.source === 'B' ? source : result);
    }
  }

  private mapped(side: Side, id: string): Pair | undefined { return this.repo.findPair(side, id); }
  private async ignore(side: Side, e: CalendarEvent, reason: string): Promise<void> {
    await this.repo.put([{ key: `ignore/${side}/${e.id}`, value: { etag: e.etag, reason } }]);
    this.report.excluded++; this.action(`excluded:${reason}`, undefined, side);
  }
  private async discover(exceptions: boolean): Promise<void> {
    for (const side of sides) for (const [, cached] of this.repo.list<Cached>(`event/${side}/`)) {
      const e = cached.event;
      if (!!e.recurringEventId !== exceptions || this.mapped(side, e.id) || cached.missing) continue;
      const ignored = this.repo.get<{ etag: string; reason: string }>(`ignore/${side}/${e.id}`);
      if (ignored && (ignored.etag === e.etag || ['manual', 'native'].includes(ignored.reason))) continue;
      if (this.repo.list<Conflict>('conflict/').some(([, c]) => side === 'A' ? c.a === e.id : c.b === e.id)) continue;
      await this.gate();
      if (e.eventType && e.eventType !== 'default') { await this.ignore(side, e, 'special'); continue; }
      if (e.recurringEventId) { await this.discoverException(side, e); continue; }
      if (isDeleted(e)) { await this.ignore(side, e, 'deleted_unmapped'); continue; }
      const marker = e.extendedProperties?.private;
      if (marker?.gcsLink || marker?.gcsPair) {
        await this.conflict('orphan', undefined, side === 'A' ? e : undefined, side === 'B' ? e : undefined); continue;
      }
      if (e.recurrence?.length && this.repo.get(`split/${side}`)) {
        await this.conflict('split', undefined, side === 'A' ? e : undefined, side === 'B' ? e : undefined); continue;
      }
      const since = this.meta().since;
      if (e.recurrence?.length) {
        if (!await this.api.hasFutureInstance(side, e.id, since)) { await this.ignore(side, e, 'before_since'); continue; }
      } else if (timeKey(e.end) < since.slice(0, e.end?.date ? 10 : undefined)) { await this.ignore(side, e, 'before_since'); continue; }
      const candidates = this.repo.list<Cached>(`event/${other(side)}/`).map(([, c]) => c.event).filter(x => !isDeleted(x) && !x.recurringEventId && !x.extendedProperties?.private?.gcsLink && !this.mapped(other(side), x.id));
      const native = e.iCalUID && kindOf(e) !== 'simple' ? candidates.find(x => x.iCalUID === e.iCalUID && x.organizer?.email && x.organizer.email === e.organizer?.email) : undefined;
      if (native) { await this.ignore(side, e, 'native'); await this.ignore(other(side), native, 'native'); continue; }
      const separate = this.repo.get(`separate/${side}/${e.id}`);
      const duplicate = !separate && candidates.find(x => x.summary === e.summary && timeKey(x.start) === timeKey(e.start) && timeKey(x.end) === timeKey(e.end) && !this.repo.get(`separate/${other(side)}/${x.id}`));
      if (duplicate) { await this.conflict('duplicate', undefined, side === 'A' ? e : duplicate, side === 'B' ? e : duplicate); continue; }
      const id = sourceId(this.config.pairId, side, e.id);
      const destId = copyId(id, 0);
      const pair: Pair = { id, origin: side, a: side === 'A' ? e.id : destId, b: side === 'B' ? e.id : destId, kind: kindOf(e), masked: isPrivate(e), generation: 0 };
      await this.planOperation(pair, { type: 'insert', target: other(side), targetId: destId, source: side, sourceId: e.id, sourceEtag: e.etag, body: copyBody(e, destId, this.config.pairId, id), notify: false });
    }
  }
  private async discoverException(side: Side, e: CalendarEvent): Promise<void> {
    const parent = this.mapped(side, e.recurringEventId!);
    if (!parent || parent.deleted || parent.suppressed || parent.conflict) return;
    if (!e.originalStartTime) throw new SyncError('instance_original_start_missing');
    const counterpart = await this.api.instance(other(side), pairEventId(parent, other(side)), e.originalStartTime);
    if (!counterpart) {
      await this.conflict('missing', undefined, side === 'A' ? e : undefined, side === 'B' ? e : undefined); return;
    }
    const id = hash([parent.id, timeKey(e.originalStartTime)]);
    const existing = this.repo.get<Pair>(pairKey(id));
    if (existing) return;
    const originSide = parent.origin;
    const origin = originSide === side ? e : counterpart;
    const pair: Pair = { id, origin: originSide, parent: parent.id, parentGeneration: parent.generation, a: side === 'A' ? e.id : counterpart.id, b: side === 'B' ? e.id : counterpart.id, kind: parent.kind, masked: parent.masked, generation: 0 };
    if (!parent.baselineA || !parent.baselineB) throw new SyncError('master_baseline_missing');
    pair.baselineA = instanceBaseline(parent.baselineA, e.originalStartTime);
    pair.baselineB = instanceBaseline(parent.baselineB, e.originalStartTime);
    await this.cache(other(side), counterpart);
    await this.repo.put([{ key: pairKey(id), value: pair }]);
    if (originSide !== side && parent.kind === 'received') {
      // Received event edits on the mirror are overwritten from the invitation.
      await this.reconcile(pair, originSide);
    } else await this.reconcile(pair);
  }
  private async recreateCopy(pair: Pair, original: CalendarEvent): Promise<void> {
    await this.cache(pair.origin, original);
    if (pair.parent) {
      const target = other(pair.origin);
      const current = await this.api.get(target, pairEventId(pair, target));
      if (!current) throw new SyncError('instance_unavailable');
      pair.suppressed = false; delete pair.conflict;
      const body: Partial<CalendarEvent> = { ...contentPatch(project(original)), status: 'confirmed' };
      delete body.recurrence;
      await this.planOperation(pair, { type: 'patch', target, targetId: current.id, expectedEtag: current.etag, source: pair.origin, sourceId: original.id, sourceEtag: original.etag, body, notify: false });
      return;
    }
    pair.generation++; pair.suppressed = false; pair.deleted = false; delete pair.conflict;
    const target = other(pair.origin); const id = copyId(pair.id, pair.generation);
    if (target === 'A') pair.a = id; else pair.b = id;
    await this.planOperation(pair, { type: 'insert', target, targetId: id, source: pair.origin, sourceId: original.id, sourceEtag: original.etag, body: copyBody(original, id, this.config.pairId, pair.id), notify: false });
  }

  private async restoreSimpleOriginal(pair: Pair, survivor: CalendarEvent, deleted: CalendarEvent): Promise<void> {
    const baseline = pair.origin === 'A' ? pair.baselineA : pair.baselineB;
    if (!baseline) throw new SyncError('original_baseline_missing');
    const body: Partial<CalendarEvent> = { ...contentPatch(toOriginal(survivor, { ...deleted, ...baseline, visibility: pair.masked ? 'private' : 'default' })), status: 'confirmed', visibility: pair.masked ? 'private' : 'default' };
    pair.deleted = false; delete pair.conflict;
    if (pair.parent) {
      delete body.recurrence;
      await this.planOperation(pair, { type: 'patch', target: pair.origin, targetId: deleted.id, expectedEtag: deleted.etag, source: other(pair.origin), sourceId: survivor.id, sourceEtag: survivor.etag, body, notify: false });
    } else {
      pair.generation++;
      const id = copyId(`${pair.id}-original`, pair.generation);
      if (pair.origin === 'A') pair.a = id; else pair.b = id;
      body.id = id; body.extendedProperties = { private: { gcsPair: this.config.pairId, gcsLink: pair.id } };
      body.reminders = { useDefault: false, overrides: [] };
      await this.planOperation(pair, { type: 'insert', target: pair.origin, targetId: id, source: other(pair.origin), sourceId: survivor.id, sourceEtag: survivor.etag, body, notify: false });
    }
  }

  /** Reattach exceptions when a suppressed series is explicitly recreated. */
  private async rebindInstance(pair: Pair, parent: Pair): Promise<void> {
    await this.gate();
    const previous = this.cached(pair.origin, pairEventId(pair, pair.origin))?.event;
    const start = previous?.originalStartTime;
    if (!start) { await this.conflict('missing', pair); return; }
    const originalRecreated = previous.recurringEventId !== pairEventId(parent, pair.origin);
    const original = originalRecreated ? await this.api.instance(pair.origin, pairEventId(parent, pair.origin), start) : await this.api.get(pair.origin, pairEventId(pair, pair.origin));
    if (!original) { await this.conflict('missing', pair); return; }
    const target = other(pair.origin);
    await this.gate(); const mirror = await this.api.instance(target, pairEventId(parent, target), start);
    if (!mirror) { await this.conflict('missing', pair); return; }
    const oldId = pairEventId(pair, target); const oldOriginalId = pairEventId(pair, pair.origin);
    if (target === 'A') { pair.a = mirror.id; pair.baselineA = content(mirror); pair.seenA = undefined; }
    else { pair.b = mirror.id; pair.baselineB = content(mirror); pair.seenB = undefined; }
    if (originalRecreated) {
      if (pair.origin === 'A') { pair.a = original.id; pair.baselineA = content(original); pair.seenA = undefined; }
      else { pair.b = original.id; pair.baselineB = content(original); pair.seenB = undefined; }
    }
    pair.parentGeneration = parent.generation;
    await this.cache(pair.origin, original); await this.cache(target, mirror);
    await this.repo.put([{ key: pairKey(pair.id), value: pair }, ...(oldId !== mirror.id ? [{ key: `ignore/${target}/${oldId}`, value: { reason: 'manual' } }] : []), ...(oldOriginalId !== original.id ? [{ key: `ignore/${pair.origin}/${oldOriginalId}`, value: { reason: 'manual' } }] : [])]);
    if (pair.suppressed || isDeleted(original)) {
      await this.planOperation(pair, { type: 'delete', target, targetId: mirror.id, expectedEtag: mirror.etag, source: pair.origin, sourceId: original.id, sourceEtag: original.etag, notify: false, suppression: !!pair.suppressed });
    } else {
      pair.deleted = false; await this.reconcile(pair, originalRecreated ? target : pair.origin);
    }
  }

  async preview(): Promise<Report> {
    const memory = new MemoryStore(await this.store.read());
    const api = new PreviewCalendar(this.api);
    const engine = new SyncEngine({ ...this.config, allowWrites: true }, memory, api);
    const started = Date.now(); const total = emptyReport();
    let progressed = false;
    // Initial previews can span many bounded passes without touching live cursors.
    do {
      const report = await engine.run(); total.status = report.status;
      for (const field of ['created', 'updated', 'deleted', 'conflicts', 'excluded', 'scanned'] as const) total[field] += report[field];
      total.actions.push(...report.actions);
      progressed = report.scanned > 0 || report.actions.length > 0;
    } while (total.status === 'pending' && progressed && Date.now() - started < 15 * 60_000);
    total.durationMs = Date.now() - started;
    return total;
  }
  async administer(fn: (repo: Repository) => Promise<void>): Promise<void> {
    const lease = await this.store.acquire(ttl);
    if (!lease) throw new SyncError('busy');
    this.repo = new Repository(this.store, lease, await this.store.read());
    this.report = emptyReport(); this.deadline = Date.now() + 60_000;
    try {
      if (this.repo.get('importing')) throw new SyncError('import_incomplete');
      if (this.meta()?.identity !== identity(this.config)) throw new SyncError('state_identity_mismatch');
      await fn(this.repo);
    } finally { await this.store.release(lease); }
  }
  async resolve(id: string, choice?: Side, disposition?: 'separate' | 'skip'): Promise<void> {
    await this.administer(async repo => {
      const conflict = repo.get<Conflict>(`conflict/${id}`);
      if (!conflict) throw new SyncError('conflict_not_found');
      const a = conflict.a ? await this.api.get('A', conflict.a) : null;
      const b = conflict.b ? await this.api.get('B', conflict.b) : null;
      if (a?.etag !== conflict.etagA || b?.etag !== conflict.etagB) throw new SyncError('resolution_stale', 'Les événements ont changé : actualiser le conflit avant de choisir.');
      if (conflict.kind === 'duplicate' && disposition) {
        for (const [side, event] of [['A', a], ['B', b]] as const) if (event) await repo.put([{ key: disposition === 'skip' ? `ignore/${side}/${event.id}` : `separate/${side}/${event.id}`, value: { etag: event.etag, reason: 'manual' } }]);
        await repo.put([{ key: `conflict/${id}` }]); return;
      }
      if (!conflict.pairId && disposition === 'skip') {
        // Explicitly exclude reviewed fragments/orphans; never infer a merge.
        for (const [side, event] of [['A', a], ['B', b]] as const) if (event) await repo.put([{ key: `ignore/${side}/${event.id}`, value: { etag: event.etag, reason: 'manual' } }]);
        await repo.put([{ key: `conflict/${id}` }]); return;
      }
      if (conflict.kind !== 'concurrent' || !choice || !conflict.pairId) throw new SyncError('manual_review_required', 'Cette anomalie nécessite une correction dans Google Calendar, puis conflicts --refresh.');
      if (!this.config.allowWrites) throw new SyncError('writes_disabled');
      const pair = repo.get<Pair>(pairKey(conflict.pairId))!;
      await this.reconcile(pair, choice);
    });
  }
  async refreshConflicts(): Promise<void> {
    await this.administer(async repo => {
      for (const [, conflict] of repo.list<Conflict>('conflict/')) {
        if (!conflict.pairId || !['concurrent', 'missing', 'unsafe', 'split'].includes(conflict.kind)) continue;
        const pair = repo.get<Pair>(pairKey(conflict.pairId))!;
        const [a, b] = await this.readPair(pair);
        if (conflict.kind === 'split') {
          const mirror = pair.origin === 'A' ? b : a;
          const base = pair.origin === 'A' ? pair.baselineB : pair.baselineA;
          if (mirror && !isDeleted(mirror) && equal(mirror.recurrence ?? [], base?.recurrence ?? [])) {
            delete pair.conflict; pair.seenA = undefined; pair.seenB = undefined;
            await repo.put([{ key: pairKey(pair.id), value: pair }, { key: `conflict/${conflict.id}` }, { key: `split/${other(pair.origin)}` }]); continue;
          }
        }
        if (conflict.kind === 'unsafe') {
          const mirror = pair.origin === 'A' ? b : a;
          if (mirror && !mirror.attendees?.length && !mirror.conferenceData) {
            delete pair.conflict; pair.seenA = undefined; pair.seenB = undefined;
            await repo.put([{ key: pairKey(pair.id), value: pair }, { key: `conflict/${conflict.id}` }]); continue;
          }
        }
        if (conflict.kind === 'missing' && a && b) {
          delete pair.conflict; pair.seenA = undefined; pair.seenB = undefined;
          await repo.put([{ key: pairKey(pair.id), value: pair }, { key: `conflict/${conflict.id}` }]); continue;
        }
        await this.conflict(conflict.kind, pair, a, b);
      }
    });
  }
  async restoreCopy(id: string): Promise<void> {
    if (!this.config.allowWrites) throw new SyncError('writes_disabled');
    await this.administer(async repo => {
      const pair = repo.get<Pair>(pairKey(id));
      if (!pair?.suppressed) throw new SyncError('copy_not_suppressed');
      const original = await this.api.get(pair.origin, pairEventId(pair, pair.origin));
      if (!original || isDeleted(original)) throw new SyncError('original_unavailable');
      await this.recreateCopy(pair, original);
    });
  }
}

/** Real reads, virtual writes: previews cannot change Google or production cursors. */
class PreviewCalendar implements CalendarGateway {
  private overlay = new Map<string, CalendarEvent>();
  constructor(private real: CalendarGateway) {}
  list: CalendarGateway['list'] = (...args) => this.real.list(...args);
  get: CalendarGateway['get'] = async (side, id) => clone(this.overlay.get(cacheKey(side, id)) ?? await this.real.get(side, id));
  insert: CalendarGateway['insert'] = async (side, body) => {
    const event = { ...clone(body), id: body.id!, etag: `preview-${randomUUID()}`, organizer: { self: true } } as CalendarEvent;
    this.overlay.set(cacheKey(side, event.id), event); return clone(event);
  };
  patch: CalendarGateway['patch'] = async (side, id, _etag, body) => {
    const current = await this.get(side, id);
    if (!current) throw new SyncError('preview_target_missing');
    const event = { ...current, ...clone(body), etag: `preview-${randomUUID()}` };
    this.overlay.set(cacheKey(side, id), event); return clone(event);
  };
  remove: CalendarGateway['remove'] = async (side, id) => { this.overlay.set(cacheKey(side, id), { id, etag: 'preview-deleted', status: 'cancelled' }); };
  instance: CalendarGateway['instance'] = async (side, id, start) => {
    const master = this.overlay.get(cacheKey(side, id));
    if (!master) return this.real.instance(side, id, start);
    const event = { ...clone(master), ...instanceBaseline(content(master), start), id: `${id}_${hash(start).slice(0, 12)}`, recurringEventId: id, originalStartTime: start, recurrence: undefined };
    this.overlay.set(cacheKey(side, event.id), event); return event;
  };
  hasFutureInstance: CalendarGateway['hasFutureInstance'] = (...args) => this.real.hasFutureInstance(...args);
}
