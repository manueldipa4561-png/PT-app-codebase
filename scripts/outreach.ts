// Today's outreach, from a tracker you filled in by hand. It prints messages to the terminal and writes nothing.
//   npm run outreach -- ~/Desktop/tracker.csv --privacy https://puntoduestudio.it/privacy
// Keep the tracker outside this repository: it holds people's contact details and the repository is public.
import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_BASE, planOutreach, readTracker, renderReport } from '../src/outreach.ts';

const USAGE = 'Usage: npm run outreach -- <tracker.csv> [--privacy URL] [--base URL] [--limit N] [--today YYYY-MM-DD]';

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { privacy: { type: 'string' }, base: { type: 'string' }, limit: { type: 'string' }, today: { type: 'string' } },
});

const [file] = positionals;
if (!file) fail(USAGE);
if (resolve(file).startsWith(resolve(import.meta.dirname, '..') + sep)) fail('Keep the tracker outside this repository: it holds contact details and the repository is public.');

const today = values.today ?? new Date().toLocaleDateString('sv-SE');
if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) fail('--today must be YYYY-MM-DD.');
const limit = values.limit === undefined ? undefined : Number(values.limit);
if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) fail('--limit must be a whole number above 0.');

try {
  const rows = readTracker(readFileSync(file, 'utf8'));
  console.log(renderReport(planOutreach(rows, { today, base: values.base ?? DEFAULT_BASE, privacyUrl: values.privacy, limit }), today));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
