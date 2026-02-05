import { ethers } from 'ethers';
import { MEMES_CONTRACT } from '@/constants';
import { getRpcUrl } from '@/alchemy';
import { numbers } from '@/numbers';
import { RequestContext } from '@/request.context';

const MANIFOLD_LAZY_CLAIM_CONTRACT =
  '0x26BBEA7803DcAc346D5F5f135b57Cf2c752A02bE';

const MANIFOLD_LAZY_CLAIM_ABI = [
  'function getClaimForToken(address creatorContractAddress, uint256 tokenId) view returns (uint256 instanceId, tuple(uint32 total, uint32 totalMax, uint32 walletMax, uint48 startDate, uint48 endDate, uint8 storageProtocol, bytes32 merkleRoot, string location, uint256 tokenId, uint256 cost, address payable paymentReceiver, address erc20, address signingAddress) claim)'
];

export class ManifoldClaimService {
  async getMintStatsFromMemeClaim(
    tokenId: number,
    ctx: RequestContext
  ): Promise<{ total: number; remaining: number }> {
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

      return { total, remaining };
    } finally {
      ctx.timer?.stop(
        `${this.constructor.name}->getRemainingEditionsForLatestMeme`
      );
    }
  }
}

export const manifoldClaimService = new ManifoldClaimService();
