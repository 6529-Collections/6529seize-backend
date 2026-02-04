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
import type { MemeClaimRowInput } from '@/meme-claims/meme-claim-from-drop.builder';
import { getMaxMemeId } from '@/nftsLoop/db.nfts';
import { RequestContext } from '@/request.context';
import { sqlExecutor } from '@/sql-executor';
import { ethers } from 'ethers';

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
  constructor(
    private readonly dropsDb: DropsDb,
    private readonly memeClaimsDb: MemeClaimsDb
  ) {}

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
    const maxSeasonId = await this.memeClaimsDb.getMaxSeasonId(ctx);
    const row = buildMemeClaimRowFromDrop(
      dropId,
      nextMemeId,
      medias,
      metadatas,
      maxSeasonId
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
      await insertAutomaticAirdrops(MEMES_CONTRACT, nextMemeId, airdrops);
    }
  }

  private async enrichRowWithComputedDetails(
    row: MemeClaimRowInput
  ): Promise<MemeClaimRowInput> {
    let image_details = row.image_details;
    let animation_details = row.animation_details;
    if (row.image) {
      try {
        image_details = await computeImageDetails(row.image);
      } catch {
        image_details = row.image_details;
      }
    }
    if (row.animation_url) {
      if (
        animation_details &&
        'format' in animation_details &&
        animation_details.format === 'HTML'
      ) {
        animation_details = animationDetailsHtml();
      } else if (
        animation_details &&
        'format' in animation_details &&
        animation_details.format === 'GLB'
      ) {
        try {
          animation_details = await computeAnimationDetailsGlb(
            row.animation_url
          );
        } catch {
          animation_details = row.animation_details;
        }
      } else {
        try {
          animation_details = await computeAnimationDetailsVideo(
            row.animation_url
          );
        } catch {
          animation_details = row.animation_details;
        }
      }
    }
    return {
      ...row,
      image_details,
      animation_details
    };
  }
}

export const memeClaimsService = new MemeClaimsService(dropsDb, memeClaimsDb);
