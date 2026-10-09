import {
  populateDistribution,
  populateDistributionNormalized
} from '@/api/distributions/api.distributions.service';
import {
  fetchPhaseName,
  fetchPhaseResults,
  getPublicSubscriptions,
  splitAllowlistResults,
  validateDistribution
} from '@/api/subscriptions/api.subscriptions.allowlist';
import { evictRedisCacheForPathWithTimeout } from '@/redis';
import {
  dropForgePreparationRepository,
  PhasePreparationResult
} from '@/drop-forge/drop-forge.preparation.repository';
import { LaunchSafetyError } from '@/drop-forge/drop-forge.types';
import { RequestContext } from '@/request.context';

export async function prepareDistributionPhase(
  contract: string,
  claim: number,
  plan: string,
  phase: string,
  auth: string,
  ctx: RequestContext = {}
): Promise<PhasePreparationResult> {
  const key = JSON.stringify([plan, phase]);
  const cachedResult = await dropForgePreparationRepository.findResult(
    contract,
    claim,
    key,
    ctx
  );
  let phaseInput: {
    name: string;
    rows: Awaited<ReturnType<typeof fetchPhaseResults>>;
  } | null = null;
  if (!cachedResult) {
    // Network work must not hold the claim's preparation lock. Recheck the
    // cache and freeze state under the lock before publishing any DB writes.
    const valid = await validateDistribution(auth, plan, phase);
    if (!valid.valid)
      throw new LaunchSafetyError(
        valid.statusText ?? 'EMMA distribution is not valid'
      );
    if (phase !== 'public') {
      const [name, rows] = await Promise.all([
        fetchPhaseName(auth, plan, phase),
        fetchPhaseResults(auth, plan, phase)
      ]);
      phaseInput = { name, rows };
    }
  }
  const result = await dropForgePreparationRepository.run(
    contract,
    claim,
    async (cached, txCtx) => {
      if (cached[key]) return cached[key];
      if (cachedResult)
        throw new LaunchSafetyError(
          'Preparation was reset during result retrieval; retry the request'
        );
      let result: PhasePreparationResult;
      if (phase === 'public') {
        const { airdrops } = await getPublicSubscriptions(
          contract,
          claim,
          txCtx
        );
        result = {
          phase: 'Public',
          airdrops,
          airdrops_unconsolidated: airdrops,
          allowlists: []
        };
      } else {
        if (!phaseInput)
          throw new LaunchSafetyError('EMMA phase input missing');
        const { name, rows } = phaseInput;
        if (Object.values(cached).some((it) => it.phase === name))
          throw new LaunchSafetyError(
            'A different preparation already used this phase name; reset explicitly before replacing it'
          );
        result = {
          phase: name,
          ...(await splitAllowlistResults(contract, claim, name, rows, txCtx))
        };
      }
      await populateDistribution(contract, claim, result.phase, result, txCtx);
      cached[key] = result;
      return result;
    },
    ctx
  );
  // Invalidation is retried by a replay too, after the durable DB result exists.
  await Promise.allSettled([
    evictRedisCacheForPathWithTimeout({
      path: `/api/minting-claims/${contract}/${claim}/`
    }),
    evictRedisCacheForPathWithTimeout({
      path: `/api/distributions/${contract}/${claim}/overview`
    })
  ]);
  return result;
}
export async function finalizeDistribution(
  contract: string,
  claim: number,
  ctx: RequestContext = {}
): Promise<void> {
  await dropForgePreparationRepository.run(
    contract,
    claim,
    async (_, txCtx) => populateDistributionNormalized(contract, claim, txCtx),
    ctx
  );
}
