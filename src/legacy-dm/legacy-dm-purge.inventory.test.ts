import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as documentationTables from '@/artwork-documentation/artwork-documentation.tables';
import * as tables from '@/constants/db-tables';
import {
  LEGACY_DM_DROP_ID_TABLES,
  LEGACY_DM_DROP_STEPS,
  LEGACY_DM_KEPT_TABLES,
  LEGACY_DM_WAVE_STEPS
} from './legacy-dm-purge.inventory';

/** Columns through which a row can belong to a DM drop or DM wave. */
const REFERENCE_COLUMNS = [
  'drop_id',
  'wave_id',
  'related_drop_id',
  'related_drop_2_id',
  'target_drop_id',
  'trigger_drop_id',
  'bot_reply_drop_id',
  'quoted_drop_id',
  'reply_to_drop_id'
];

/**
 * Tables outside the DM purge by construction: competition and decision
 * storage (DM waves are chat-only and the purge refuses while any
 * competition entry sits in a DM wave), and NFT/minting records keyed by
 * public drops.
 */
const OUT_OF_SCOPE_PREFIXES = [
  'competition',
  'wave_decision',
  'winner_drop',
  'meme_collaboration'
];
const OUT_OF_SCOPE: Readonly<Record<string, string>> = {
  [tables.MEME_CARD_DROP_MAPPINGS_TABLE]:
    'Meme card submissions (public waves)',
  [tables.MINTING_CLAIMS_TABLE]: 'Minting claims (public waves)',
  [tables.RELEASE_DIGESTS_TABLE]: 'Release digests (official public wave)',
  [tables.ART_CURATION_TOKEN_WATCHES_TABLE]:
    'Blocker: any watch on a DM wave stops the purge',
  [tables.IDENTITY_SUBSCRIPTIONS_TABLE]:
    'Follows of a wave are metadata; follows of a DM drop are purged by step',
  [tables.WAVES_DECISION_PAUSES_TABLE]: 'Competition scheduling',
  [tables.WAVE_OUTCOMES_TABLE]: 'Competition outcomes',
  [tables.WAVE_LEADERBOARD_ENTRIES_TABLE]: 'Competition leaderboards'
};

function entityFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return ['node_modules', 'generated', 'dist'].includes(entry.name)
        ? []
        : entityFiles(path);
    }
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')
      ? [path]
      : [];
  });
}

function referencingTables(): Map<string, string[]> {
  const constants = {
    ...documentationTables,
    ...tables
  } as unknown as Record<string, unknown>;
  const found = new Map<string, string[]>();
  for (const file of entityFiles(join(__dirname, '..'))) {
    const source = readFileSync(file, 'utf8');
    for (const chunk of source.split('@Entity(').slice(1)) {
      const name = chunk.slice(0, chunk.indexOf(')')).trim();
      const table =
        typeof constants[name] === 'string'
          ? (constants[name] as string)
          : name;
      const columns = REFERENCE_COLUMNS.filter((column) =>
        new RegExp(String.raw`\b${column}[!?]?:`).test(chunk)
      );
      if (columns.length) found.set(table, columns);
    }
  }
  return found;
}

describe('legacy DM purge inventory', () => {
  const purged = new Set<string>([
    ...LEGACY_DM_DROP_ID_TABLES,
    ...LEGACY_DM_DROP_STEPS.map((step) => step.table),
    ...LEGACY_DM_WAVE_STEPS.map((step) => step.table)
  ]);

  it('finds the drop and wave tables it is meant to guard', () => {
    const found = referencingTables();
    expect(found.has(tables.DROPS_PARTS_TABLE)).toBe(true);
    expect(found.has(tables.DROP_REACTIONS_TABLE)).toBe(true);
    expect(found.has(tables.IDENTITY_NOTIFICATIONS_TABLE)).toBe(true);
  });

  it('accounts for every table that references a drop or a wave', () => {
    const unaccounted = Array.from(referencingTables().keys()).filter(
      (table) =>
        !purged.has(table) &&
        !(table in LEGACY_DM_KEPT_TABLES) &&
        !(table in OUT_OF_SCOPE) &&
        !OUT_OF_SCOPE_PREFIXES.some((prefix) => table.startsWith(prefix))
    );
    expect(unaccounted.sort((a, b) => a.localeCompare(b))).toEqual([]);
  });

  it('never both purges and keeps a table', () => {
    const both = Array.from(purged).filter(
      (table) =>
        table in LEGACY_DM_KEPT_TABLES &&
        table !== tables.DROPS_TABLE &&
        table !== tables.IDENTITY_NOTIFICATIONS_TABLE
    );
    expect(both).toEqual([]);
  });

  it('binds every step placeholder', () => {
    for (const step of [...LEGACY_DM_DROP_STEPS, ...LEGACY_DM_WAVE_STEPS]) {
      expect(step.where.split('?').length - 1).toBe(step.bindings);
    }
  });
});
