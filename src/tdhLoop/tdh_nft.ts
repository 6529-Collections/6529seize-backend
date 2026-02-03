import { GRADIENT_CONTRACT, MEMES_CONTRACT } from '@/constants';
import { persistNftTdh } from '../db';
import {
  ConsolidatedTDH,
  NftTDH,
  TokenTDH,
  TokenTDHRank
} from '../entities/ITDH';
import { Logger } from '../logging';
import {
  NEXTGEN_CORE_CONTRACT,
  getNextgenNetwork
} from '../nextgen/nextgen_constants';

const logger = Logger.get('TDH_NFT');

export const updateNftTDH = async (
  tdh: ConsolidatedTDH[],
  startingWallets?: string[]
) => {
  logger.info(`[FINDING NFT TDH...]`);
  const tokenTdhs = tdh.map((t) => {
    const memesTdh = findContractTDH(
      MEMES_CONTRACT,
      t.consolidation_key,
      t.boost,
      t.memes,
      t.memes_ranks
    );
    const gradientsTdh = findContractTDH(
      GRADIENT_CONTRACT,
      t.consolidation_key,
      t.boost,
      t.gradients,
      t.gradients_ranks
    );
    const nextgenTdh = findContractTDH(
      NEXTGEN_CORE_CONTRACT[getNextgenNetwork()],
      t.consolidation_key,
      t.boost,
      t.nextgen,
      t.nextgen_ranks
    );
    return [...memesTdh, ...gradientsTdh, ...nextgenTdh];
  });
  logger.info(`[FOUND ${tokenTdhs.length}]`);
  await persistNftTdh(tokenTdhs.flat(), startingWallets);
};

const findContractTDH = (
  contract: string,
  consolidationKey: string,
  boost: number,
  tokenTdh: TokenTDH[],
  ranks: TokenTDHRank[]
): NftTDH[] => {
  return tokenTdh.map((t) => {
    const rank = ranks.find((r) => r.id === t.id);
    return {
      consolidation_key: consolidationKey,
      contract: contract.toLowerCase(),
      id: t.id,
      balance: t.balance,
      tdh: t.tdh,
      tdh__raw: t.tdh__raw,
      tdh_rank: rank?.rank ?? -1,
      boost: boost,
      boosted_tdh: Math.round(t.tdh * boost)
    };
  });
};
