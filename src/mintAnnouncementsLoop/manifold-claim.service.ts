import { ethers } from 'ethers';
import { MEMES_CONTRACT } from '@/constants';
import { getRpcUrl } from '@/alchemy';
import { getMaxMemeId } from '@/nftsLoop/db.nfts';
import { Logger } from '@/logging';
import { numbers } from '@/numbers';
import { RequestContext } from '@/request.context';

const MANIFOLD_LAZY_CLAIM_CONTRACT =
  '0x26BBEA7803DcAc346D5F5f135b57Cf2c752A02bE';

const MANIFOLD_LAZY_CLAIM_ABI = [
  'function getClaimForToken(address creatorContractAddress, uint256 tokenId) view returns (uint256 instanceId, tuple(uint32 total, uint32 totalMax, uint32 walletMax, uint48 startDate, uint48 endDate, uint8 storageProtocol, bytes32 merkleRoot, string location, uint256 tokenId, uint256 cost, address payable paymentReceiver, address erc20, address signingAddress) claim)'
];

export class ManifoldClaimService {
  private readonly logger = Logger.get(this.constructor.name);

  async getRemainingEditionsForLatestMeme(
    ctx: RequestContext
  ): Promise<number> {
    try {
      ctx.timer?.start(
        `${this.constructor.name}->getRemainingEditionsForLatestMeme`
      );
      const tokenId = await getMaxMemeId();
      if (!tokenId) {
        throw new Error('No meme tokens found');
      }

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
      const total = numbers.parseIntOrThrow(claim.total);
      const totalMax = numbers.parseIntOrThrow(claim.totalMax);
      const remainingEditions = totalMax - total;

      this.logger.info(
        `Claim info for token ${tokenId}: total=${total}, totalMax=${totalMax}, remaining=${remainingEditions}`
      );

      return remainingEditions;
    } finally {
      ctx.timer?.stop(
        `${this.constructor.name}->getRemainingEditionsForLatestMeme`
      );
    }
  }
}

export const manifoldClaimService = new ManifoldClaimService();
