import { SUBSCRIPTIONS_ID_STATE_TABLE } from '@/constants';
import type { RecordLogEntry } from '@/signed-records/record-log/record-log-format';
import { sqlExecutor } from '@/sql-executor';
import {
  closeSubscriptionWrites,
  OPENING_STATE_ID,
  openSubscriptionWrites,
  scheduleIdentitySwitch,
  subscriptionsIdentitySwitch
} from '../identity/identity-switch';
import {
  applyJournalBody,
  identityTablesHash,
  journal,
  JournalBody,
  journalBodyOf
} from '../timeline/journal';
import { sha256Hex } from './opening-file';
import {
  loadOpeningFiles,
  ParsedOpening,
  parseOpeningFiles
} from './opening-load';

/** Fetches a published file's text by URI (a public GET; no credentials). */
export type Fetcher = (uri: string) => Promise<string>;

export const publicFetcher: Fetcher = async (uri) => {
  const { default: fetch } = await import('node-fetch');
  const response = await fetch(uri);
  if (!response.ok) {
    throw new Error(`GET ${uri} answered ${response.status}`);
  }
  return response.text();
};

/**
 * What a rebuild reads the journal through: the shared record log's
 * public chain, in log order (the records module's RecordLogReader over
 * the records wave, from the relays). Nothing in MySQL.
 */
export interface JournalSource {
  walk(chain: 'public'): AsyncIterable<{ readonly entry: RecordLogEntry }>;
}

let boundSource: (() => JournalSource) | null = null;

/**
 * Binds where the CLI's rebuild reads the record log: the records wave
 * reader, once a relay client for the records wave lands. Until then the CLI's
 * rebuild says so and stops.
 */
export function setJournalSource(source: (() => JournalSource) | null): void {
  boundSource = source;
}

export function boundJournalSource(): JournalSource {
  if (!boundSource) {
    throw new Error(
      'No record log source is bound: the rebuild reads the journal from the records wave'
    );
  }
  return boundSource();
}

export interface RebuildResult {
  readonly openingSha256: string;
  readonly entries: number;
  readonly checkpoints: number;
  /** Entries of other openings (earlier loads, rehearsals), skipped. */
  readonly skipped: number;
  readonly switched: boolean;
}

async function journalOf(source: JournalSource): Promise<JournalBody[]> {
  const bodies: JournalBody[] = [];
  for await (const { entry } of source.walk('public')) {
    const body = journalBodyOf(entry);
    if (body) {
      bodies.push(body);
    }
  }
  return bodies;
}

interface PublishedOpening {
  readonly parsed: ParsedOpening;
  readonly openingUri: string;
  readonly historyUri: string;
}

/** The opening of the last switch in the journal, fetched and checked. */
async function lastSwitchedOpening(
  bodies: readonly JournalBody[],
  fetch: Fetcher
): Promise<PublishedOpening> {
  const switched = bodies.filter((b) => b.kind === 'opening').pop();
  if (!switched) {
    throw new Error('The journal names no opening that went live');
  }
  const inputs = switched.inputs as {
    opening_uri: string;
    opening_sha256: string;
    history_uri: string;
    history_sha256: string;
  };
  const openingBytes = await fetch(inputs.opening_uri);
  const historyBytes = await fetch(inputs.history_uri);
  if (sha256Hex(openingBytes) !== inputs.opening_sha256) {
    throw new Error(
      `${inputs.opening_uri} does not hash to ${inputs.opening_sha256}`
    );
  }
  if (sha256Hex(historyBytes) !== inputs.history_sha256) {
    throw new Error(
      `${inputs.history_uri} does not hash to ${inputs.history_sha256}`
    );
  }
  return {
    parsed: parseOpeningFiles(openingBytes, historyBytes),
    openingUri: inputs.opening_uri,
    historyUri: inputs.history_uri
  };
}

/** Writes stay paused through a rebuild; the marker is renewed as it goes. */
const MARKER_RENEW_EVERY = 100;

/**
 * Rebuilds the identity tables from the opening file and the journal alone:
 *
 * 1. pause the unsigned write routes (go-live's marker, renewed while the
 *    rebuild runs);
 * 2. read the journal (lane `subs` of the record log's public chain);
 * 3. take the opening of the last `opening` entry (go-live writes it with
 *    the switch), fetch its two files and check their sha256; or take the
 *    files given (a rehearsal);
 * 4. load them into tables that are not the truth, and hold them suspended,
 *    so no identity writer writes while the journal is written back;
 * 5. write back, in log order, every entry made against that opening:
 *    each identity's rows, each history row, each fold's moved rows;
 * 6. at each checkpoint (a build), hash the rebuilt tables and stop at the
 *    first difference.
 *
 * The rebuilt tables are then verified and in shadow, not the truth. With
 * `goLive` they become the truth through go-live's own switch, in the same
 * pause, only if at least one checkpoint matched (the comparison) and the
 * opening came from the journal (so its entry can name the files again).
 * On any failure the routes reopen and the tables are left suspended.
 */
export async function rebuildIdentityTables(params: {
  readonly source: JournalSource;
  readonly fetch?: Fetcher;
  /** A rehearsal: these files instead of the last switched opening. */
  readonly opening?: ParsedOpening;
  readonly goLive?: boolean;
  readonly now?: () => number;
}): Promise<RebuildResult> {
  const now = params.now ?? (() => Date.now());
  await closeSubscriptionWrites(now());
  try {
    const bodies = await journalOf(params.source);
    const published = params.opening
      ? null
      : await lastSwitchedOpening(bodies, params.fetch ?? publicFetcher);
    const opening = params.opening ?? published!.parsed;
    if (params.goLive && !published) {
      throw new Error(
        'Only a rebuild from the journal goes live: rehearsal files name no published opening'
      );
    }
    await loadOpeningFiles(opening, now());
    await setSuspended(now());
    let entries = 0;
    let checkpoints = 0;
    let skipped = 0;
    for (let index = 0; index < bodies.length; index++) {
      const body = bodies[index];
      if (body.opening !== opening.openingSha256) {
        skipped++;
        continue;
      }
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          const options = { wrappedConnection: connection };
          await applyJournalBody(body, options);
          if (body.state_sha256 !== null) {
            const rebuilt = await identityTablesHash(options);
            if (rebuilt !== body.state_sha256) {
              throw new Error(
                `The rebuilt tables differ from the checkpoint of journal entry ${index} (${body.kind} ${JSON.stringify(body.inputs)})`
              );
            }
            checkpoints++;
          }
        }
      );
      entries++;
      if (entries % MARKER_RENEW_EVERY === 0) {
        await closeSubscriptionWrites(now());
      }
    }
    // Verified and back in shadow: the identity writers go on from here.
    await sqlExecutor.execute(
      `UPDATE ${SUBSCRIPTIONS_ID_STATE_TABLE}
          SET verified_at = :nowMs, suspended_at = NULL
        WHERE id = :id`,
      { nowMs: now(), id: OPENING_STATE_ID }
    );
    let switched = false;
    if (params.goLive) {
      if (checkpoints === 0) {
        throw new Error(
          'No checkpoint was compared; the rebuilt tables stay in shadow'
        );
      }
      switched = await switchRebuilt(opening, published!, now());
    }
    return {
      openingSha256: opening.openingSha256,
      entries,
      checkpoints,
      skipped,
      switched
    };
  } finally {
    subscriptionsIdentitySwitch.invalidate();
    await openSubscriptionWrites();
  }
}

async function setSuspended(nowMs: number): Promise<void> {
  await sqlExecutor.execute(
    `UPDATE ${SUBSCRIPTIONS_ID_STATE_TABLE} SET suspended_at = :nowMs WHERE id = :id`,
    { nowMs, id: OPENING_STATE_ID }
  );
}

/**
 * The rebuilt tables are current as of now (writes are paused, and every
 * journaled write is in them), so the cut is now and the switch follows
 * it, with the journal's opening entry naming the same files again.
 */
async function switchRebuilt(
  opening: ParsedOpening,
  published: PublishedOpening,
  nowMs: number
): Promise<boolean> {
  await sqlExecutor.execute(
    `UPDATE ${SUBSCRIPTIONS_ID_STATE_TABLE}
        SET cut_at = :nowMs, opening_uri = :openingUri, history_uri = :historyUri
      WHERE id = :id`,
    {
      nowMs,
      openingUri: published.openingUri,
      historyUri: published.historyUri,
      id: OPENING_STATE_ID
    }
  );
  return scheduleIdentitySwitch(nowMs, opening.openingSha256, (options) =>
    journal(
      {
        kind: 'opening',
        inputs: {
          opening_uri: published.openingUri,
          opening_sha256: opening.openingSha256,
          history_uri: published.historyUri,
          history_sha256: opening.historySha256,
          cut_at: opening.opening.cut.at,
          rebuilt: true
        }
      },
      options
    ).then(() => undefined)
  );
}
