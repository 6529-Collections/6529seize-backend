import { upsertAutomaticAirdropsForPhase } from '@/api/distributions/api.distributions.service';
import {
  DISTRIBUTION_PHASE_AIRDROP_TEAM,
  DISTRIBUTION_PHASE_AIRDROP_ARTIST
} from '@/airdrop-phases';
import { MEMES_CONTRACT, TEAM_TABLE } from '@/constants';
import { dropsDb, DropsDb } from '@/drops/drops.db';
import type { DropMetadataEntity } from '@/entities/IDrop';
import { buildMemeClaimRowFromDrop } from '@/meme-claims/meme-claim-from-drop.builder';
import { MemeClaimsDb, memeClaimsDb } from '@/meme-claims/meme-claims.db';
import {
  computeImageDetails,
  computeAnimationDetailsVideo,
  animationDetailsHtml,
  computeAnimationDetailsGlb
} from '@/meme-claims/media-inspector';
import type { MemeClaimAnimationDetails } from '@/entities/IMemeClaim';
import type { MemeClaimRowInput } from '@/meme-claims/meme-claim-from-drop.builder';
import { fetchPublicUrlToBuffer } from '@/http/safe-fetch';
import { Logger } from '@/logging';
import { getMaxMemeId } from '@/nftsLoop/db.nfts';
import { numbers } from '@/numbers';
import { RequestContext } from '@/request.context';
import { sqlExecutor } from '@/sql-executor';
import { ethers } from 'ethers';

const MEME_CALENDAR_API_BASE = 'https://6529.io/api/meme-calendar';
const MEME_CALENDAR_TIMEOUT_MS = 10_000;

async function resolveAnimationDetails(
  animationUrl: string,
  existing: MemeClaimAnimationDetails | null | undefined
): Promise<MemeClaimAnimationDetails | null | undefined> {
  if (existing && 'format' in existing && existing.format === 'HTML') {
    return animationDetailsHtml();
  }
  if (existing && 'format' in existing && existing.format === 'GLB') {
    try {
      return await computeAnimationDetailsGlb(animationUrl);
    } catch {
      return existing;
    }
  }
  try {
    return await computeAnimationDetailsVideo(animationUrl);
  } catch {
    return existing;
  }
}

function parseAirdropConfigFromMetadatas(
  metadatas: DropMetadataEntity[]
): Array<{ address: string; count: number }> {
  const row = metadatas.find((m) => m.data_key === 'airdrop_config');
  if (!row?.data_value) return [];
  try {
    const arr = JSON.parse(row.data_value) as Array<{
      id?: string;
      address?: string;
      count?: number;
    }>;
    if (!Array.isArray(arr)) return [];
    const out: Array<{ address: string; count: number }> = [];
    for (const item of arr) {
      const address = item?.address?.trim();
      const count =
        typeof item?.count === 'number' ? item.count : Number(item?.count);
      if (
        !address ||
        !ethers.isAddress(address) ||
        !Number.isInteger(count) ||
        count <= 0
      )
        continue;
      out.push({ address, count });
    }
    return out;
  } catch {
    return [];
  }
}

type TeamWalletRow = {
  wallet: string;
  collection: string;
};

const TEAM_COLLECTION_MAIN = '6529Team';
const TEAM_COLLECTION_FUNDS = '6529Funds';

async function fetchTeamWalletRows(): Promise<TeamWalletRow[]> {
  const rows = await sqlExecutor.execute<TeamWalletRow>(
    `SELECT wallet, collection FROM ${TEAM_TABLE}`
  );
  return rows
    .map((r) => ({
      wallet: r.wallet?.trim() ?? '',
      collection: r.collection?.trim() ?? ''
    }))
    .filter((r) => r.wallet && ethers.isAddress(r.wallet));
}

function buildTeamAirdrops(rows: TeamWalletRow[]): Array<{
  address: string;
  count: number;
}> {
  const walletCountMap = new Map<string, number>();
  for (const row of rows) {
    if (
      row.collection !== TEAM_COLLECTION_MAIN &&
      row.collection !== TEAM_COLLECTION_FUNDS
    ) {
      continue;
    }
    const key = row.wallet.toLowerCase();
    walletCountMap.set(key, (walletCountMap.get(key) ?? 0) + 1);
  }
  return Array.from(walletCountMap.entries()).map(([address, count]) => ({
    address,
    count
  }));
}

export class MemeClaimsService {
  private readonly logger = Logger.get(this.constructor.name);

  constructor(
    private readonly dropsDb: DropsDb,
    private readonly memeClaimsDb: MemeClaimsDb
  ) {}

  async createClaimForDropIfMissing(dropId: string): Promise<void> {
    await this.memeClaimsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const exists = await this.memeClaimsDb.existsByDropId(
          dropId,
          connection
        );
        if (exists) {
          this.logger.info(
            `Skipping claim build for drop_id=${dropId} because it already exists`
          );
          return;
        }
        await this.createClaimForDrop(dropId, { connection });
      }
    );
  }

  async createClaimForDrop(dropId: string, ctx: RequestContext): Promise<void> {
    const nextMemeId =
      (await getMaxMemeId(false, {
        wrappedConnection: ctx.connection
      })) + 1;
    const [mediasByDrop, metadatas] = await Promise.all([
      this.dropsDb.getDropMedia([dropId], ctx.connection),
      this.dropsDb.findMetadataByDropIds([dropId], ctx.connection)
    ]);
    const medias = mediasByDrop[dropId] ?? [];
    const seasonId = await this.resolveSeasonForClaimBuild(nextMemeId, ctx);
    const row = buildMemeClaimRowFromDrop(
      dropId,
      nextMemeId,
      medias,
      metadatas,
      seasonId
    );
    const enriched = await this.enrichRowWithComputedDetails(row);
    await this.memeClaimsDb.createMemeClaim([enriched], ctx);

    const teamWalletRows = await fetchTeamWalletRows();
    const airdropConfigEntries = parseAirdropConfigFromMetadatas(metadatas);
    const teamAirdrops = buildTeamAirdrops(teamWalletRows);

    const artistWalletCountMap = new Map<string, number>();
    for (const { address, count } of airdropConfigEntries) {
      const key = address.toLowerCase();
      artistWalletCountMap.set(
        key,
        (artistWalletCountMap.get(key) ?? 0) + count
      );
    }
    const artistAirdrops = Array.from(artistWalletCountMap.entries()).map(
      ([address, count]) => ({
        address,
        count
      })
    );

    await upsertAutomaticAirdropsForPhase(
      MEMES_CONTRACT,
      nextMemeId,
      DISTRIBUTION_PHASE_AIRDROP_ARTIST,
      artistAirdrops,
      ctx.connection,
      true
    );
    await upsertAutomaticAirdropsForPhase(
      MEMES_CONTRACT,
      nextMemeId,
      DISTRIBUTION_PHASE_AIRDROP_TEAM,
      teamAirdrops,
      ctx.connection,
      true
    );
  }

  private async resolveSeasonForClaimBuild(
    memeId: number,
    ctx: RequestContext
  ): Promise<number> {
    const calendarUrl = `${MEME_CALENDAR_API_BASE}/${memeId}`;
    try {
      const { buffer } = await fetchPublicUrlToBuffer(calendarUrl, {
        timeoutMs: MEME_CALENDAR_TIMEOUT_MS,
        headers: {
          Accept: 'application/json',
          'User-Agent': '6529ClaimsBuilder/1.0'
        }
      });
      const parsed = JSON.parse(buffer.toString('utf8')) as {
        season?: unknown;
      };
      const season = numbers.parseIntOrNull(parsed?.season);
      if (season !== null && season > 0) {
        this.logger.info(
          `Using meme-calendar season=${season} for meme_id=${memeId}`
        );
        return season;
      }
      this.logger.warn(
        `Invalid season from meme-calendar for meme_id=${memeId}, value=${parsed?.season}; falling back to max season`
      );
    } catch (error) {
      this.logger.warn(
        `Failed to resolve season from meme-calendar for meme_id=${memeId}; falling back to max season`,
        { error }
      );
    }
    return await this.memeClaimsDb.getMaxSeasonId(ctx);
  }

  private async enrichRowWithComputedDetails(
    row: MemeClaimRowInput
  ): Promise<MemeClaimRowInput> {
    let image_details = row.image_details;
    if (row.image_url) {
      try {
        image_details = await computeImageDetails(row.image_url);
      } catch {
        image_details = row.image_details;
      }
    }
    let animation_details = row.animation_details;
    if (row.animation_url) {
      const resolved = await resolveAnimationDetails(
        row.animation_url,
        row.animation_details ?? undefined
      );
      animation_details = resolved ?? row.animation_details;
    }
    return {
      ...row,
      image_details,
      animation_details
    };
  }
}

export const memeClaimsService = new MemeClaimsService(dropsDb, memeClaimsDb);
