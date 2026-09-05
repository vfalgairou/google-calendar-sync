import { z } from 'zod';
import { identity, type Config } from './config.js';
import { SyncError, type Meta } from './types.js';
import type { Store } from './store.js';
import { hash } from './content.js';

const envelope = z.object({ format: z.literal('calendar-sync-state'), version: z.literal(1), exportedAt: z.string(), records: z.record(z.string(), z.unknown()) }).strict();
export async function exportState(store: Store): Promise<z.infer<typeof envelope>> {
  const lease = await store.acquire(90_000);
  if (!lease) throw new SyncError('busy');
  try {
    const records = await store.read();
    if (records.importing) throw new SyncError('import_incomplete');
    return { format: 'calendar-sync-state', version: 1, exportedAt: new Date().toISOString(), records };
  }
  finally { await store.release(lease); }
}
export async function importState(store: Store, data: unknown, config: Config): Promise<void> {
  const snapshot = envelope.parse(data);
  const meta = snapshot.records.meta as Meta | undefined;
  if (meta?.version !== 1 || meta.identity !== identity(config)) throw new SyncError('state_identity_mismatch');
  if (Object.keys(snapshot.records).some(k => !/^(meta$|event\/|pair\/|op\/|conflict\/|ignore\/|separate\/|split\/)/.test(k))) throw new SyncError('invalid_state_key');
  const lease = await store.acquire(90_000);
  if (!lease) throw new SyncError('busy');
  try {
    const current = await store.read(); const fingerprint = hash(snapshot);
    if (Object.keys(current).length && current.importing !== fingerprint) throw new SyncError('import_target_not_empty', 'Importer dans un stockage vide ; l’état existant ne sera pas écrasé.');
    // The import marker prevents running against a partial Firestore import.
    await store.commit(lease, [{ key: 'importing', value: fingerprint }]);
    const changes = Object.entries(snapshot.records).map(([key, value]) => ({ key, value }));
    for (let i = 0; i < changes.length; i += 200) { await store.renew(lease, 90_000); await store.commit(lease, changes.slice(i, i + 200)); }
    await store.commit(lease, [{ key: 'importing' }]);
  } finally { await store.release(lease); }
}
