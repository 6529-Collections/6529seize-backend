import { E2EE_RECORD_TABLES } from '@/e2ee/relay/e2ee-record-tables';
import {
  E2eeRebuildProblem,
  E2eeRebuildSource,
  rebuildE2eeState
} from '@/e2ee/relay/e2ee-rebuild';
import {
  compareE2eeTables,
  E2eeRebuildDb,
  e2eeRebuildDb,
  E2eeTableComparison
} from '@/e2ee/relay/e2ee-rebuild.db';
import { E2eeRelaySettings } from '@/e2ee/relay/e2ee-relay-config';
import { E2eeRelayPool } from '@/e2ee/relay/e2ee-relay-pool';
import { CrpItem } from '@/e2ee/relay/e2ee-crp';
import { E2eeStreamHead } from '@/e2ee/relay/e2ee-stream-store';
import { Logger } from '@/logging';

const logger = Logger.get('E2EE_REBUILD');
const REPORTED_PROBLEMS = 50;

/**
 * Reads the families from every configured relay and keeps one copy of
 * each event; payloads come from the first relay that has them.
 */
export function relayE2eeRebuildSource(pool: E2eeRelayPool): E2eeRebuildSource {
  const payloads = new Map<string, Buffer | null>();
  return {
    async events(families) {
      const byId = new Map<string, CrpItem>();
      let reached = 0;
      for (const url of pool.urls) {
        try {
          for (const item of await pool.replay(url, families)) {
            if (!byId.has(item.event.id)) byId.set(item.event.id, item);
          }
          reached++;
        } catch (error) {
          logger.warn(
            `[REBUILD] ${url} unreadable: ${(error as Error).message}`
          );
        }
      }
      if (!reached) throw new Error('No relay could be read');
      return Array.from(byId.values());
    },
    async payload(sha256) {
      if (payloads.has(sha256)) return payloads.get(sha256) ?? null;
      let found: Buffer | null = null;
      for (const url of pool.urls) {
        found = await pool.payload(url, sha256).catch(() => null);
        if (found) break;
      }
      payloads.set(sha256, found);
      return found;
    }
  };
}

export interface E2eeHeadComparison {
  readonly mysql: number;
  readonly relays: number;
  readonly missing: number;
  readonly behind: number;
  readonly differ: number;
  readonly examples: readonly string[];
}

/** MySQL's stream heads against the heads the relays' records give. */
export function compareE2eeHeads(
  rebuilt: readonly E2eeStreamHead[],
  mysql: readonly E2eeStreamHead[]
): E2eeHeadComparison {
  const relays = new Map(rebuilt.map((head) => [head.wave, head]));
  const examples: string[] = [];
  let missing = 0;
  let behind = 0;
  let differ = 0;
  const held = mysql.filter((head) => head.pos > 0);
  for (const head of held) {
    const other = relays.get(head.wave);
    if (!other) {
      missing++;
      if (examples.length < 5) examples.push(`missing ${head.wave}`);
    } else if (other.pos < head.pos) {
      behind++;
      if (examples.length < 5) {
        examples.push(`behind ${head.wave}: ${other.pos} < ${head.pos}`);
      }
    } else if (other.pos !== head.pos || other.hash !== head.hash) {
      differ++;
      if (examples.length < 5) examples.push(`differs ${head.wave}`);
    }
  }
  return {
    mysql: held.length,
    relays: rebuilt.length,
    missing,
    behind,
    differ,
    examples
  };
}

export interface E2eeRebuildReport {
  readonly mode: 'verify' | 'write';
  readonly stats: { events: number; records: number; streams: number };
  readonly problemCount: number;
  readonly problems: readonly E2eeRebuildProblem[];
  readonly heads?: E2eeHeadComparison;
  readonly tables?: readonly E2eeTableComparison[];
  readonly written: boolean;
  /** True when every check passed. */
  readonly ok: boolean;
}

/**
 * The rebuild from the relays.
 * - `verify` (the side-by-side check): rebuilds in memory and compares the
 *   stream heads and every row with MySQL. Writes nothing.
 * - `write`: rebuilds into empty tables, and refuses if any is not empty.
 */
export async function runE2eeRebuild(input: {
  readonly mode: 'verify' | 'write';
  readonly now: number;
  readonly settings: E2eeRelaySettings;
  readonly source?: E2eeRebuildSource;
  readonly db?: E2eeRebuildDb;
}): Promise<E2eeRebuildReport> {
  const db = input.db ?? e2eeRebuildDb;
  const ordererDeviceKey = input.settings.ordererPublicKey;
  if (!ordererDeviceKey) throw new Error('No orderer public key is configured');
  let source = input.source;
  let pool: E2eeRelayPool | null = null;
  if (!source) {
    const reader = input.settings.siteReader;
    if (!reader) throw new Error('No site-reader key is configured');
    pool = new E2eeRelayPool({
      urls: input.settings.urls,
      net: input.settings.net,
      identity: reader
    });
    source = relayE2eeRebuildSource(pool);
  }
  try {
    if (input.mode === 'write') {
      const counts = await db.counts();
      const filled = Object.entries(counts).filter(([, count]) => count > 0);
      if (filled.length) {
        throw new Error(
          `Rebuild writes only into empty tables: ${filled
            .map(([table, count]) => `${table} (${count})`)
            .join(', ')}`
        );
      }
    }
    const state = await rebuildE2eeState(source, {
      ordererDeviceKey,
      now: input.now
    });
    const base = {
      mode: input.mode,
      stats: state.stats,
      problemCount: state.problems.length,
      problems: state.problems.slice(0, REPORTED_PROBLEMS)
    };
    if (input.mode === 'write') {
      await db.insert(state, input.now);
      return { ...base, written: true, ok: state.problems.length === 0 };
    }
    const heads = compareE2eeHeads(state.heads, await db.heads());
    const tables: E2eeTableComparison[] = [];
    for (const table of Object.keys(E2EE_RECORD_TABLES)) {
      tables.push(
        compareE2eeTables(
          table,
          state.tables.get(table) ?? new Map(),
          await db.rows(table)
        )
      );
    }
    const ok =
      state.problems.length === 0 &&
      heads.missing + heads.behind + heads.differ === 0 &&
      tables.every((t) => t.missing + t.extra + t.changed === 0);
    return { ...base, heads, tables, written: false, ok };
  } finally {
    pool?.close();
  }
}
