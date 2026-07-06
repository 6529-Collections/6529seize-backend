import { ethers } from 'ethers';
import {
  MANIFOLD_LAZY_CLAIM_ABI,
  MANIFOLD_LAZY_CLAIM_CONTRACT,
  MEMES_CONTRACT
} from '@/constants';
import { getRpcUrl } from '@/alchemy';
import { numbers } from '@/numbers';
import { RequestContext } from '@/request.context';

export class ManifoldClaimService {
  async getMintStatsFromMemeClaim(
    tokenId: number,
    ctx: RequestContext
  ): Promise<{ minted: number; total: number; remaining: number }> {
    try {
      ctx.timer?.start(
        `${this.constructor.name}->getRemainingEditionsForLatestMeme`
      );

      const provider = new ethers.JsonRpcProvider(getRpcUrl(1));
      const contract = new ethers.Contract(
        MANIFOLD_LAZY_CLAIM_CONTRACT,
        MANIFOLD_LAZY_CLAIM_ABI,
        provider
      );

      const [, claim] = await contract.getClaimForToken(
        MEMES_CONTRACT,
        tokenId
      );
      const minted = numbers.parseIntOrThrow(claim.total);
      const total = numbers.parseIntOrThrow(claim.totalMax);
      const remaining = total - minted;

      return { minted, total, remaining };
    } finally {
      ctx.timer?.stop(
        `${this.constructor.name}->getRemainingEditionsForLatestMeme`
      );
    }
  }
}

export const manifoldClaimService = new ManifoldClaimService();
