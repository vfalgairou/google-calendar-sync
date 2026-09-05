import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import type { Config } from './config.js';
import { timeKey } from './content.js';
import type { CalendarEvent, CalendarGateway, EventTime, Page, Side } from './types.js';
import { sides, SyncError } from './types.js';

export const credentialSchema = z.object({
  client_id: z.string().min(1), client_secret: z.string().min(1), refresh_token: z.string().min(1),
});
export const scopes = ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly'];
export function oauthClient(credentials: z.infer<typeof credentialSchema>): OAuth2Client {
  const client = new OAuth2Client({ clientId: credentials.client_id, clientSecret: credentials.client_secret });
  client.setCredentials({ refresh_token: credentials.refresh_token });
  return client;
}
export function sanitizedError(error: unknown): SyncError {
  if (error instanceof SyncError) return error;
  const e = error as { response?: { status?: number; data?: { error?: string | { errors?: { reason?: string }[] } } }; code?: string };
  const status = e.response?.status;
  const detail = e.response?.data?.error;
  if (detail === 'invalid_grant' || status === 401) return new SyncError('auth_revoked', 'Autorisation Google à renouveler.', status);
  const reason = typeof detail === 'object' ? detail?.errors?.[0]?.reason : undefined;
  if (status === 429 || (status === 403 && ['rateLimitExceeded', 'userRateLimitExceeded'].includes(reason ?? ''))) return new SyncError('rate_limited', 'Limitation temporaire Google.', status);
  if (status === 403) return new SyncError('access_denied', 'Accès refusé au calendrier.', status);
  if (status === 412) return new SyncError('precondition_failed', 'La version Google a changé.', status);
  if (status === 410) return new SyncError('gone', 'Ressource ou curseur expiré.', status);
  if (status === 409) return new SyncError('already_exists', 'Identifiant déjà utilisé.', status);
  if (status && status >= 500) return new SyncError('google_unavailable', 'Google temporairement indisponible.', status);
  if (!status) return new SyncError('network_error', 'Requête interrompue ou réseau indisponible.');
  return new SyncError('google_request_failed', `Requête Google refusée (HTTP ${status}).`, status);
}
export class GoogleCalendar implements CalendarGateway {
  constructor(private config: Config, private clients: Record<Side, OAuth2Client>) {}
  static async open(config: Config): Promise<GoogleCalendar> {
    const clients = {} as Record<Side, OAuth2Client>;
    for (const side of sides) clients[side] = oauthClient(credentialSchema.parse(JSON.parse(await readFile(config.calendars[side].credentialsFile, 'utf8'))));
    return new GoogleCalendar(config, clients);
  }
  private url(side: Side, suffix = ''): string {
    return `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.config.calendars[side].calendarId)}/events${suffix}`;
  }
  private async request<T>(side: Side, options: Parameters<OAuth2Client['request']>[0]): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try { return (await this.clients[side].request<T>({ ...options, timeout: 12_000, retry: false })).data; }
      catch (error) {
        const safe = sanitizedError(error);
        // Writes are reconciled by the operation journal, not blindly retried here.
        if (options.method !== 'GET' || attempt >= 2 || !['rate_limited', 'google_unavailable', 'network_error'].includes(safe.code)) throw safe;
        await delay(250 * 2 ** attempt + Math.random() * 100);
      }
    }
  }
  async list(side: Side, query: { syncToken?: string; pageToken?: string }): Promise<Page> {
    const result = await this.request<Partial<Page>>(side, { method: 'GET', url: this.url(side), params: { ...query, showDeleted: true, singleEvents: false, maxResults: 200 } });
    return { ...result, items: result.items ?? [] };
  }
  async get(side: Side, id: string): Promise<CalendarEvent | null> {
    try { return await this.request(side, { method: 'GET', url: this.url(side, `/${encodeURIComponent(id)}`) }); }
    catch (e) { if (e instanceof SyncError && [404, 410].includes(e.status ?? 0)) return null; throw e; }
  }
  async insert(side: Side, event: Partial<CalendarEvent>): Promise<CalendarEvent> {
    if (event.attendees?.length) throw new SyncError('copy_attendees_forbidden');
    return this.request(side, { method: 'POST', url: this.url(side), params: { sendUpdates: 'none' }, data: event });
  }
  async patch(side: Side, id: string, etag: string, body: Partial<CalendarEvent>, notify: boolean): Promise<CalendarEvent> {
    return this.request(side, { method: 'PATCH', url: this.url(side, `/${encodeURIComponent(id)}`), headers: { 'If-Match': etag }, params: { sendUpdates: notify ? 'all' : 'none' }, data: body });
  }
  async remove(side: Side, id: string, etag: string): Promise<void> {
    await this.request(side, { method: 'DELETE', url: this.url(side, `/${encodeURIComponent(id)}`), headers: { 'If-Match': etag }, params: { sendUpdates: 'none' } });
  }
  async instance(side: Side, masterId: string, originalStart: EventTime): Promise<CalendarEvent | null> {
    const result = await this.request<Partial<Page>>(side, { method: 'GET', url: this.url(side, `/${encodeURIComponent(masterId)}/instances`), params: { originalStart: originalStart.date ?? originalStart.dateTime, showDeleted: true, maxResults: 250 } });
    return result.items?.find(e => timeKey(e.originalStartTime) === timeKey(originalStart)) ?? null;
  }
  async hasFutureInstance(side: Side, masterId: string, since: string): Promise<boolean> {
    const result = await this.request<Partial<Page>>(side, { method: 'GET', url: this.url(side, `/${encodeURIComponent(masterId)}/instances`), params: { timeMin: since, showDeleted: false, maxResults: 1 } });
    if (result.items?.length) return true;
    if (result.nextPageToken) throw new SyncError('instance_page_incomplete');
    return false;
  }
}
