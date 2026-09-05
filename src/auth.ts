import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import { configSchema } from './config.js';
import { scopes, sanitizedError } from './google.js';
import { sides, SyncError } from './types.js';

interface CalendarInfo { id: string; summary: string; accessRole: string; primary?: boolean }
export async function authorize(clientId: string, clientSecret: string, show: (url: string) => void): Promise<{ client: OAuth2Client; refreshToken: string }> {
  const state = randomBytes(32).toString('hex');
  const client = new OAuth2Client({ clientId, clientSecret });
  const pkce = await client.generateCodeVerifierAsync();
  let resolveCode!: (code: string) => void; let rejectCode!: (e: Error) => void;
  const result = new Promise<string>((yes, no) => { resolveCode = yes; rejectCode = no; });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/oauth/callback') { response.writeHead(404).end(); return; }
    if (url.searchParams.get('state') !== state) { response.writeHead(400).end('État OAuth invalide.'); return; }
    const code = url.searchParams.get('code');
    if (!code) { response.writeHead(400).end('Autorisation refusée.'); rejectCode(new SyncError('authorization_declined')); return; }
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end('Autorisation reçue. Vous pouvez fermer cet onglet et revenir au terminal.');
    resolveCode(code);
  });
  await new Promise<void>((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new SyncError('oauth_listener_failed');
  const redirect = `http://127.0.0.1:${address.port}/oauth/callback`;
  const timeout = setTimeout(() => rejectCode(new SyncError('authorization_timeout')), 180_000);
  try {
    const url = client.generateAuthUrl({ redirect_uri: redirect, access_type: 'offline', prompt: 'consent select_account', scope: scopes, state, code_challenge: pkce.codeChallenge, code_challenge_method: CodeChallengeMethod.S256 });
    show(url);
    const code = await result;
    const { tokens } = await client.getToken({ code, codeVerifier: pkce.codeVerifier, redirect_uri: redirect });
    if (!tokens.refresh_token) throw new SyncError('refresh_token_missing');
    client.setCredentials(tokens);
    return { client, refreshToken: tokens.refresh_token };
  } finally { clearTimeout(timeout); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
export async function accessibleCalendars(client: OAuth2Client): Promise<CalendarInfo[]> {
  const calendars: CalendarInfo[] = []; let pageToken: string | undefined;
  do {
    const response = await client.request<{ items?: CalendarInfo[]; nextPageToken?: string }>({ url: 'https://www.googleapis.com/calendar/v3/users/me/calendarList', params: { pageToken }, timeout: 12_000 });
    calendars.push(...(response.data.items ?? []).filter(c => ['writer', 'owner'].includes(c.accessRole)));
    pageToken = response.data.nextPageToken;
  } while (pageToken);
  return calendars;
}
export async function configure(configPath: string, clientPath: string): Promise<void> {
  const clientFile = z.object({ installed: z.object({ client_id: z.string(), client_secret: z.string() }) }).parse(JSON.parse(await readFile(clientPath, 'utf8'))).installed;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const secretDir = resolve(dirname(configPath), 'secrets');
  await mkdir(secretDir, { recursive: true, mode: 0o700 });
  const calendars = {} as Record<'A' | 'B', { calendarId: string; credentialsFile: string }>;
  try {
    for (const side of sides) {
      process.stdout.write(`\nConnexion du compte ${side}. Sélectionner le compte Google correspondant dans le navigateur.\n`);
      const { client, refreshToken } = await authorize(clientFile.client_id, clientFile.client_secret, url => {
        process.stdout.write(`Ouvrir ce lien si le navigateur ne démarre pas :\n${url}\n`);
        const browser = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore' });
        browser.on('error', () => {});
      });
      const available = await accessibleCalendars(client);
      if (!available.length) throw new SyncError('no_writable_calendar');
      available.forEach((c, i) => process.stdout.write(`${i + 1}. ${c.summary} — ${c.id}${c.primary ? ' (principal)' : ''}\n`));
      const selection = Number(await rl.question(`Calendrier ${side} (numéro) : `));
      const calendar = Number.isInteger(selection) ? available[selection - 1] : undefined;
      if (!calendar) throw new SyncError('invalid_calendar_selection');
      if (side === 'B' && calendar.id === calendars.A.calendarId) throw new SyncError('identical_calendars');
      const credentialsFile = resolve(secretDir, `${side}.credentials.json`);
      await writeFile(credentialsFile, `${JSON.stringify({ ...clientFile, refresh_token: refreshToken }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      calendars[side] = { calendarId: calendar.id, credentialsFile };
    }
    const backend = (await rl.question('Stockage : sqlite ou firestore [sqlite] : ')).trim() || 'sqlite';
    const storage = backend === 'firestore'
      ? { type: 'firestore', projectId: (await rl.question('Identifiant du projet Google Cloud : ')).trim() }
      : { type: 'sqlite', path: resolve(dirname(configPath), 'data/state.sqlite') };
    const config = configSchema.parse({ calendars, storage, allowWrites: false });
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    process.stdout.write(`\nConfiguration enregistrée dans ${resolve(configPath)}. Lancer preview avant de passer allowWrites à true.\n`);
  } catch (error) { throw error instanceof z.ZodError || (error as NodeJS.ErrnoException).code === 'EEXIST' ? error : sanitizedError(error); }
  finally { rl.close(); }
}
