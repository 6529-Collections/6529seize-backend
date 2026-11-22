import { SUBSCRIPTIONS_ID_STATE_TABLE } from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import {
  IdentityDirectory,
  mirrorIdentityDirectory
} from '../identity/identity-directory';
import {
  OPENING_STATE_ID,
  subscriptionsIdentitySwitch
} from '../identity/identity-switch';
import {
  applyBuildEffects,
  recordIdentityUpload
} from '../writers/identity-daily-build';
import { foldBoundWallets } from '../writers/identity-fold';
import { redeemIdentityAirdrops } from '../writers/identity-redemptions';
import { creditIdentityTopUps } from '../writers/identity-top-ups';
import { OPENING_FORMAT, sha256Hex } from './opening-file';
import { loadOpeningFiles, parseOpeningFiles } from './opening-load';
import { BUILD_RECORD_FORMAT, BuildRecord, ChainLink } from './published-chain';

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

export interface RebuildResult {
  readonly openingSha256: string;
  readonly buildRecords: number;
  readonly topUpsCredited: number;
  readonly walletsFolded: number;
  readonly airdropsCharged: number;
}

/**
 * Rebuilds the identity tables from what was published and from their
 * sources, into tables that are empty or suspended:
 *
 * 1. walk the published chain back from its head to the opening file,
 *    checking each file against the sha256 its successor names;
 * 2. load the opening and history files;
 * 3. apply each build record in order (automatic rows, queue pushes, log
 *    lines, the card's final rows with their ids, the list's URI);
 * 4. `beforeRedemptions`: the phase pulls, which the mint log records by
 *    final row id, are applied here by the mint log's own rebuild;
 * 5. credit the top-ups (legacy top-up rows, from Ethereum), fold wallets
 *    bound since the opening (from the identity mirror), and charge the
 *    airdrop mints (from the transactions table) up to the block the legacy
 *    redemption loop has processed.
 *
 * The rebuilt tables are the truth again from the opening's cut (the state
 * row is marked verified, with the switch at the cut and the chain head).
 */
export async function rebuildIdentityTables(params: {
  readonly head: ChainLink;
  /** Where the history file is, when the head is the opening file itself. */
  readonly historyUri?: string;
  readonly fetch?: Fetcher;
  readonly directory?: IdentityDirectory;
  readonly beforeRedemptions?: () => Promise<void>;
  readonly nowMs?: number;
}): Promise<RebuildResult> {
  const fetch = params.fetch ?? publicFetcher;
  const directory = params.directory ?? mirrorIdentityDirectory;
  const records: BuildRecord[] = [];
  let link: ChainLink = params.head;
  let historyUri = params.historyUri;
  let openingBytes: string | null = null;
  let openingUri = '';
  for (;;) {
    const bytes = await fetch(link.uri);
    if (sha256Hex(bytes) !== link.sha256) {
      throw new Error(`${link.uri} does not hash to ${link.sha256}`);
    }
    const parsed = JSON.parse(bytes) as { format?: string };
    if (parsed.format === BUILD_RECORD_FORMAT) {
      const record = parsed as BuildRecord;
      records.unshift(record);
      historyUri = record.previous.historyUri ?? historyUri;
      link = record.previous;
      continue;
    }
    if (parsed.format === OPENING_FORMAT) {
      openingBytes = bytes;
      openingUri = link.uri;
      break;
    }
    throw new Error(
      `${link.uri} is neither a build record nor an opening file`
    );
  }
  if (!historyUri) {
    throw new Error('No history file URI: pass it with the head');
  }
  const opening = parseOpeningFiles(openingBytes, await fetch(historyUri));
  await loadOpeningFiles(opening, params.nowMs);
  for (const record of records) {
    await applyBuildEffects(record.effects);
    await recordIdentityUpload({
      contract: record.effects.contract,
      token_id: record.effects.tokenId,
      date: new Date(record.effects.buildAtMs).toISOString().slice(0, 10),
      upload_url: record.listUri
    });
  }
  if (params.beforeRedemptions) {
    await params.beforeRedemptions();
  }
  const topUpsCredited = await creditIdentityTopUps(directory);
  const walletsFolded = await foldBoundWallets(directory);
  const run = await redeemIdentityAirdrops();
  const nowMs = params.nowMs ?? Date.now();
  await sqlExecutor.execute(
    `UPDATE ${SUBSCRIPTIONS_ID_STATE_TABLE}
        SET verified_at = :nowMs, switch_at = LEAST(cut_at, :nowMs),
            opening_uri = :openingUri, history_uri = :historyUri,
            head_uri = :headUri, head_sha256 = :headSha
      WHERE id = :id`,
    {
      nowMs,
      openingUri,
      historyUri,
      headUri: params.head.uri,
      headSha: params.head.sha256,
      id: OPENING_STATE_ID
    }
  );
  subscriptionsIdentitySwitch.invalidate();
  return {
    openingSha256: opening.openingSha256,
    buildRecords: records.length,
    topUpsCredited,
    walletsFolded,
    airdropsCharged: run?.charged ?? 0
  };
}
