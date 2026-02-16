import { insertAutomaticAirdrops } from '@/api/distributions/api.distributions.service';
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

async function fetchTeamWallets(): Promise<string[]> {
  const rows = await sqlExecutor.execute<{ wallet: string }>(
    `SELECT wallet FROM ${TEAM_TABLE}`
  );
  return rows
    .map((r) => r.wallet?.trim())
    .filter((w) => w && ethers.isAddress(w));
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

    const teamWallets = await fetchTeamWallets();
    const airdropConfigEntries = parseAirdropConfigFromMetadatas(metadatas);
    const walletCountMap = new Map<string, number>();
    for (const w of teamWallets) {
      const key = w.toLowerCase();
      walletCountMap.set(key, (walletCountMap.get(key) ?? 0) + 1);
    }
    for (const { address, count } of airdropConfigEntries) {
      const key = address.toLowerCase();
      walletCountMap.set(key, (walletCountMap.get(key) ?? 0) + count);
    }
    const airdrops = Array.from(walletCountMap.entries()).map(
      ([wallet, count]) => ({ address: wallet, count })
    );
    if (airdrops.length > 0) {
      await insertAutomaticAirdrops(
        MEMES_CONTRACT,
        nextMemeId,
        airdrops,
        ctx.connection
      );
    }
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
