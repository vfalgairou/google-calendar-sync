#!/usr/bin/env node
import { Command } from 'commander';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { readConfig } from './config.js';
import { configure } from './auth.js';
import { GoogleCalendar, sanitizedError } from './google.js';
import { openStore } from './store.js';
import { SyncEngine } from './engine.js';
import { createSyncServer } from './server.js';
import { exportState, importState } from './state.js';
import type { Conflict, Meta, Pair, Side } from './types.js';
import { SyncError } from './types.js';

const program = new Command().name('calendar-sync').description('Synchronisation bidirectionnelle de deux calendriers Google.').version('0.1.0').option('-c, --config <path>', 'Fichier de configuration', process.env.SYNC_CONFIG ?? 'config.json');
const output = (value: unknown): void => { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); };
const log = (value: Record<string, unknown>): void => { process.stderr.write(`${JSON.stringify(value)}\n`); };
async function context(needsApi = true) {
  const config = await readConfig(program.opts<{ config: string }>().config);
  const store = await openStore(config);
  try {
    const engine = needsApi ? new SyncEngine(config, store, await GoogleCalendar.open(config), log) : undefined;
    return { config, store, engine: engine! };
  } catch (e) { await store.close(); throw e; }
}
program.command('configure').description('Connecter les comptes et choisir les calendriers (sur le poste local).').requiredOption('--client <path>', 'Client OAuth Google de type application de bureau').action(async options => configure(program.opts<{ config: string }>().config, options.client));
for (const name of ['preview', 'sync'] as const) program.command(name).description(name === 'preview' ? 'Aperçu sans écriture dans Calendar.' : 'Exécuter un passage.').action(async () => {
  const { engine, store } = await context();
  try { output(await engine[name === 'sync' ? 'run' : 'preview']()); } finally { await store.close(); }
});
program.command('status').description('Dernier passage, retard et conflits.').option('--check', 'Code de sortie non nul si aucun succès depuis dix minutes').action(async options => {
  const { store } = await context(false);
  try {
    const records = await store.read(); const meta = records.meta as Meta | undefined;
    if (options.check && (!meta?.lastSuccess || Date.now() - Date.parse(meta.lastSuccess) > 600_000 || records.importing)) process.exitCode = 1;
    output({ initialized: !!meta, importing: !!records.importing, lastSuccess: meta?.lastSuccess, lagSeconds: meta?.lastSuccess ? Math.floor((Date.now() - Date.parse(meta.lastSuccess)) / 1000) : null, lastError: meta?.lastError, lastReport: meta?.lastReport, conflicts: Object.keys(records).filter(k => k.startsWith('conflict/')).length, hiddenCopies: Object.entries(records).filter(([k, v]) => k.startsWith('pair/') && (v as Pair).suppressed).map(([, v]) => (v as Pair).id) });
  } finally { await store.close(); }
});
program.command('conflicts').description('Différences détaillées : sortie sensible réservée au terminal.').option('--refresh', 'Actualiser les versions après une correction dans Google Calendar').action(async options => {
  const { engine, store } = await context(!!options.refresh);
  try { if (options.refresh) await engine.refreshConflicts(); output(Object.entries(await store.read()).filter(([key]) => key.startsWith('conflict/')).map(([, value]) => value as Conflict)); }
  finally { await store.close(); }
});
program.command('resolve <id>').description('Résoudre un conflit ou qualifier un doublon.').option('--choose <side>', 'Version A ou B').option('--separate', 'Le doublon apparent représente deux événements distincts').option('--skip', 'Exclure un doublon ou un fragment/orphelin non associé après revue').action(async (id, options) => {
  if ([!!options.choose, !!options.separate, !!options.skip].filter(Boolean).length !== 1 || (options.choose && !['A', 'B'].includes(options.choose))) throw new SyncError('invalid_resolution_options');
  const { engine, store } = await context();
  try { await engine.resolve(id, options.choose as Side | undefined, options.separate ? 'separate' : options.skip ? 'skip' : undefined); output({ resolved: id }); }
  finally { await store.close(); }
});
program.command('restore-copy <pairId>').description('Rétablir une copie de réunion masquée.').action(async id => {
  const { engine, store } = await context();
  try { await engine.restoreCopy(id); output({ restored: id }); } finally { await store.close(); }
});
const state = program.command('state').description('Sauvegarder et transférer l’état ; arrêter les exécutions avant un transfert.');
state.command('export <file>').action(async file => {
  const { store } = await context(false);
  try { await writeFile(file, `${JSON.stringify(await exportState(store))}\n`, { mode: 0o600, flag: 'wx' }); output({ exported: file }); }
  finally { await store.close(); }
});
state.command('import <file>').action(async file => {
  const { config, store } = await context(false);
  try { await importState(store, JSON.parse(await readFile(file, 'utf8')), config); output({ imported: file }); }
  finally { await store.close(); }
});
program.command('run').description('Boucle du serveur dédié, interruption propre par SIGTERM.').action(async () => {
  const { config, engine, store } = await context();
  const controller = new AbortController();
  const stop = () => controller.abort(); process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try {
    while (!controller.signal.aborted) {
      const start = Date.now();
      try { await engine.run(); } catch (e) { if (['auth_revoked', 'access_denied', 'writes_disabled', 'state_identity_mismatch'].includes(sanitizedError(e).code)) throw e; }
      await delay(Math.max(0, config.intervalSeconds * 1000 - (Date.now() - start)), undefined, { signal: controller.signal }).catch(() => {});
    }
  } finally { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); await store.close(); }
});
program.command('serve').description('Service HTTP privé Cloud Run (protection IAM requise).').action(async () => {
  const { engine, store } = await context();
  const server = createSyncServer(engine);
  await new Promise<void>((yes, no) => { server.once('error', no); server.listen(Number(process.env.PORT ?? 8080), '0.0.0.0', yes); });
  await new Promise<void>(resolve => {
    const stop = () => { server.close(() => resolve()); server.closeIdleConnections(); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
  });
  await store.close();
});
try { await program.parseAsync(); }
catch (error) {
  const localCode = (error as NodeJS.ErrnoException).code;
  const safe = error instanceof z.ZodError ? { code: 'invalid_configuration', message: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') } : ['ENOENT', 'EEXIST', 'EACCES'].includes(localCode ?? '') ? { code: localCode, message: 'Vérifier le chemin et les droits du fichier ; aucun fichier existant ne sera écrasé.' } : sanitizedError(error);
  log({ severity: 'ERROR', event: safe.code, message: safe.message }); process.exitCode = 1;
}
