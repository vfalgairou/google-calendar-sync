import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';

const account = z.object({ calendarId: z.string().min(1), credentialsFile: z.string().min(1) }).strict();
export const configSchema = z.object({
  pairId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/).default('principal'),
  calendars: z.object({ A: account, B: account }).strict(),
  storage: z.discriminatedUnion('type', [
    z.object({ type: z.literal('sqlite'), path: z.string().min(1) }).strict(),
    z.object({ type: z.literal('firestore'), projectId: z.string().min(1), databaseId: z.string().default('(default)') }).strict(),
  ]),
  intervalSeconds: z.number().int().min(30).default(120),
  runBudgetSeconds: z.number().int().min(5).max(240).default(45),
  allowWrites: z.boolean().default(false),
}).strict().refine(c => c.calendars.A.calendarId !== c.calendars.B.calendarId, 'Les calendriers doivent être distincts.');
export type Config = z.infer<typeof configSchema>;
export async function readConfig(path: string): Promise<Config> {
  const config = configSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  // Paths are relative to the working directory, including inside Docker.
  for (const account of Object.values(config.calendars)) account.credentialsFile = resolve(account.credentialsFile);
  return config;
}
export function identity(config: Config): string {
  return createHash('sha256').update(JSON.stringify([config.pairId, config.calendars.A.calendarId, config.calendars.B.calendarId])).digest('hex');
}
