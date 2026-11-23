import fetch from 'node-fetch';
import { Logger } from '@/logging';
import {
  RecordLogReader,
  SegmentFetcher
} from '@/signed-records/record-log/record-log-reader';
import { LocalRecordsWaveReader } from '@/signed-records/record-log/records-wave-local-reader';
import { loadProviderKeys } from '@/signed-records/sealed-crypto';
import { ipfsMintContent } from './mint-log-content';
import { rebuildMintLogFromRecordLog } from './mint-log-rebuild.run';

const logger = Logger.get('MINT_LOG_REBUILD_CHECK');

/** What the rebuild check's runner passes a step (src/rebuild/manifest.types.ts). */
interface CheckStepContext {
  readonly sources: { readonly files: string | null };
}

/** Segment files from the run's files source (`/ipfs/<cid>`, `/ar/<id>`). */
function filesFetcher(base: string): SegmentFetcher {
  const get = async (path: string): Promise<Buffer> => {
    const response = await fetch(`${base.replace(/\/+$/, '')}${path}`);
    if (!response.ok) {
      throw new Error(`${path} answered ${response.status}`);
    }
    return response.buffer();
  };
  return {
    fetchCid: (cid) => get(`/ipfs/${encodeURIComponent(cid)}`),
    fetchArweave: (id) => get(`/ar/${encodeURIComponent(id)}`)
  };
}

/**
 * The rebuild check's rebuilder for the mint log's tables: the production
 * rebuild (rebuildMintLogFromRecordLog) from empty tables, reading
 * - the record log from the records wave's head drops (the drops table, as
 *   the records service posted them) and its segment files from the files
 *   source, and
 * - the genesis files from the files source.
 * It fails when the log holds no mint entry, so a seed whose entries never
 * reached a segment cannot pass as an empty rebuild.
 */
export async function rebuildMintLogInCheck(
  ctx: CheckStepContext,
  env: Readonly<Record<string, string | undefined>> = process.env
): Promise<void> {
  const files = ctx.sources.files;
  if (!files) {
    throw new Error(
      'The mint log rebuild reads files: the run has no files source'
    );
  }
  const waveId = env.SIGNED_RECORDS_WAVE_ID;
  const profileId = env.SIGNED_RECORDS_SERVICE_PROFILE_ID;
  const wallet = env.SIGNED_RECORDS_SERVICE_WALLET?.toLowerCase();
  const providers = loadProviderKeys(env.SIGNED_RECORDS_PROVIDER_KEYS);
  if (!waveId || !profileId || !wallet || providers.length === 0) {
    throw new Error(
      'The mint log rebuild reads the records wave: SIGNED_RECORDS_WAVE_ID, SIGNED_RECORDS_SERVICE_PROFILE_ID, SIGNED_RECORDS_SERVICE_WALLET and SIGNED_RECORDS_PROVIDER_KEYS are needed'
    );
  }
  const result = await rebuildMintLogFromRecordLog({
    source: new RecordLogReader({
      wave: new LocalRecordsWaveReader({ waveId, profileId, wallet }),
      fetcher: filesFetcher(files),
      serviceWallets: [wallet],
      providers
    }),
    content: ipfsMintContent(files)
  });
  if (result.entries === 0) {
    throw new Error(
      "The record log holds no mint entry: the seed's entries never reached a closed segment"
    );
  }
  logger.info(
    `[MINT_LOG_REBUILD_CHECK] [entries ${result.entries}] [heads ${Object.keys(result.heads).join(', ')}]`
  );
}
