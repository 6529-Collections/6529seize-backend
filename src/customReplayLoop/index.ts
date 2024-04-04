import { loadEnv, unload } from '../secrets';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { getDataSource } from '../db';
import {
  DISTRIBUTION_NORMALIZED_TABLE,
  DISTRIBUTION_TABLE,
  MEMELAB_CONTRACT
} from '../constants';
import { areEqualAddresses } from '../helpers';
import { DistributionNormalized } from '../entities/IDistribution';

const logger = Logger.get('CUSTOM_REPLAY_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  logger.info(`[RUNNING]`);
  await loadEnv([]);
  await replay();
  await unload();
  logger.info('[COMPLETE]');
});

async function replay() {
  logger.info(`[CUSTOM REPLAY NOT IMPLEMENTED]`);
  return;

  const distinctDistributions: { contract: string; card_id: number }[] =
    await getDataSource().manager.query(
      `SELECT DISTINCT contract, card_id FROM ${DISTRIBUTION_TABLE};`
    );

  const distrinctNormalizedDistributions: {
    contract: string;
    card_id: number;
  }[] = await getDataSource().manager.query(
    `SELECT DISTINCT contract, card_id FROM ${DISTRIBUTION_NORMALIZED_TABLE};`
  );

  const missingDistributions: { contract: string; card_id: number }[] =
    distinctDistributions.filter(
      (distribution) =>
        !distrinctNormalizedDistributions.some(
          (normalizedDistribution) =>
            areEqualAddresses(
              normalizedDistribution.contract,
              distribution.contract
            ) &&
            Number(normalizedDistribution.card_id) ===
              Number(distribution.card_id)
        )
    );

  missingDistributions.sort((a, d) => {
    if (!areEqualAddresses(d.contract, a.contract)) {
      return d.contract.localeCompare(a.contract);
    }
    return d.card_id - a.card_id;
  });

  logger.info(
    `[${missingDistributions.length} MISSING] : [${distinctDistributions.length} DISTINCT] : [${distrinctNormalizedDistributions.length} DISTINCT NORMALIZED]`
  );

  for (const missingDistribution of missingDistributions) {
    const manager = getDataSource().manager;
    const distributions = await manager.query(
      `SELECT * FROM ${DISTRIBUTION_TABLE} WHERE contract = "${missingDistribution.contract}" AND card_id = ${missingDistribution.card_id};`
    );

    logger.info(
      `[REPLAYING DISTRIBUTION] : [${missingDistribution.contract} #${missingDistribution.card_id}] : [FOUND ${distributions.length} DISTRIBUTIONS]`
    );

    const distributionsNormalized = new Map<string, DistributionNormalized>();

    for (const entry of distributions) {
      const key = entry.wallet.toLowerCase();
      let dn = distributionsNormalized.get(key);
      if (!dn) {
        const ens = await manager.query(
          `SELECT display FROM ens WHERE wallet = '${entry.wallet}'`
        );
        const nftsTable = areEqualAddresses(entry.contract, MEMELAB_CONTRACT)
          ? 'nfts_meme_lab'
          : 'nfts';
        const nft = await manager.query(
          `SELECT * FROM ${nftsTable} WHERE id = '${entry.card_id}'`
        );
        dn = {
          contract: entry.contract,
          card_id: entry.card_id,
          card_name: nft[0]?.name ?? null,
          mint_date:
            nft[0]?.mint_date.toISOString().slice(0, 19).replace('T', ' ') ??
            null,
          wallet: entry.wallet,
          wallet_display: ens[0]?.display ?? entry.wallet,
          allowlist: [],
          phases: [],
          minted: 0,
          airdrops: 0,
          total_spots: 0,
          total_count: 0
        };
      }

      if (entry.phase === 'Airdrop') {
        dn.airdrops += entry.count;
        dn.total_count += entry.count;
      } else {
        const dPhase = {
          phase: entry.phase,
          spots: entry.count
        };
        dn.allowlist.push(dPhase);
        dn.total_spots += entry.count;
      }
      dn.phases.push(entry.phase);
      distributionsNormalized.set(key, dn);
    }

    const normalizedDistributions = Array.from(
      distributionsNormalized.values()
    );
    await manager.query(
      `INSERT INTO ${DISTRIBUTION_NORMALIZED_TABLE} (contract, card_id, card_name, mint_date, wallet, wallet_display, allowlist, phases, minted, airdrops, total_spots, total_count) VALUES ${normalizedDistributions
        .map(
          (dn) =>
            `("${dn.contract}", ${dn.card_id}, "${dn.card_name}", "${
              dn.mint_date
            }", "${dn.wallet}", "${dn.wallet_display}", '${JSON.stringify(
              dn.allowlist
            )}', '${JSON.stringify(dn.phases)}', ${dn.minted}, ${
              dn.airdrops
            }, ${dn.total_spots}, ${dn.total_count})`
        )
        .join(', ')}`
    );
  }
}
