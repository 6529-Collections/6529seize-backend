import { createHash } from 'node:crypto';
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
import { afterCommitAwaited } from '@/db/after-commit';
import {
  dropForgePreparationRepository,
  PhasePreparationResult
} from '@/drop-forge/drop-forge.preparation.repository';
import { canonicalMemePhaseName } from '@/drop-forge/drop-forge.emma-phases';
import { LaunchSafetyError } from '@/drop-forge/drop-forge.types';
import { RequestContext } from '@/request.context';
import {
  dropForgeNormalizeSpec,
  dropForgePhaseSpec,
  logDropForgeWrite
} from '@/mint-log/mint-log-drop-forge';

/** A phase's rows: the public phase, or a split of its allowlist results. */
async function writePhase(
  args: {
    readonly contract: string;
    readonly claim: number;
    readonly phase: string;
    readonly name: string;
    readonly rows: Awaited<ReturnType<typeof fetchPhaseResults>>;
    readonly sourceHash?: string;
  },
  ctx: RequestContext
): Promise<PhasePreparationResult> {
  const { contract, claim, name } = args;
  let prepared: PhasePreparationResult;
  if (args.phase === 'public') {
    const { airdrops } = await getPublicSubscriptions(contract, claim, ctx);
    prepared = {
      phase: 'Public',
      airdrops,
      airdrops_unconsolidated: airdrops,
      allowlists: []
    };
  } else {
    prepared = {
      phase: name,
      ...(await splitAllowlistResults(contract, claim, name, args.rows, ctx))
    };
  }
  if (args.sourceHash) prepared.source_hash = args.sourceHash;
  await populateDistribution(contract, claim, prepared.phase, prepared, ctx);
  return prepared;
}

export async function prepareDistributionPhase(
  contract: string,
  claim: number,
  plan: string,
  phase: string,
  auth: string,
  ctx: RequestContext = {},
  frozenInput?: {
    name: string;
    rows: Awaited<ReturnType<typeof fetchPhaseResults>>;
  }
): Promise<PhasePreparationResult> {
  const key = JSON.stringify([plan, phase]);
  const cachedResult = await dropForgePreparationRepository.findResult(
    contract,
    claim,
    key,
    ctx
  );
  const sourceHash = frozenInput
    ? createHash('sha256').update(JSON.stringify(frozenInput)).digest('hex')
    : undefined;
  if (sourceHash && cachedResult && cachedResult.source_hash !== sourceHash)
    throw new LaunchSafetyError(
      'EMMA inputs changed since prior processing; reset the distribution before processing again'
    );
  let phaseInput: {
    name: string;
    rows: Awaited<ReturnType<typeof fetchPhaseResults>>;
  } | null = frozenInput ?? null;
  if (!cachedResult && !frozenInput) {
    // Network work must not hold the claim's preparation lock. Recheck the
    // cache and freeze state under the lock before publishing any DB writes.
    const valid = await validateDistribution(auth, plan, phase, 'background');
    if (!valid.valid)
      throw new LaunchSafetyError(
        valid.statusText ?? 'EMMA distribution is not valid'
      );
    if (phase !== 'public') {
      const [name, rows] = await Promise.all([
        fetchPhaseName(auth, plan, phase, 'background'),
        fetchPhaseResults(auth, plan, phase, 'background')
      ]);
      phaseInput = { name, rows };
    }
  }
  const result = await dropForgePreparationRepository.run(
    contract,
    claim,
    async (cached, txCtx) => {
      if (cached[key]) {
        if (sourceHash && cached[key].source_hash !== sourceHash)
          throw new LaunchSafetyError(
            'EMMA inputs changed; reset before processing'
          );
        return cached[key];
      }
      if (cachedResult)
        throw new LaunchSafetyError(
          'Preparation was reset during result retrieval; retry the request'
        );
      let name = 'Public';
      if (phase !== 'public') {
        if (!phaseInput)
          throw new LaunchSafetyError('EMMA phase input missing');
        name = canonicalMemePhaseName(phaseInput.name) ?? phaseInput.name;
        if (
          Object.values(cached).some(
            (it) => (canonicalMemePhaseName(it.phase) ?? it.phase) === name
          )
        )
          throw new LaunchSafetyError(
            'A different preparation already used this phase name; reset explicitly before replacing it'
          );
      }
      // Checked above for every phase but the public one.
      const rows = phase === 'public' ? [] : (phaseInput?.rows ?? []);
      // The phase's writes, logged in the mint log as the phase split route
      // logs them, inside this preparation's transaction.
      const result = await logDropForgeWrite(
        dropForgePhaseSpec<PhasePreparationResult>({
          contract,
          claim,
          plan,
          phase,
          phaseName: name,
          results: rows
        }),
        txCtx,
        () =>
          writePhase({ contract, claim, phase, name, rows, sourceHash }, txCtx)
      );
      cached[key] = result;
      return result;
    },
    ctx
  );
  // Invalidation is retried by a replay too, after the durable DB result
  // exists: after the job's commit, so the transaction (and the mint log's
  // head) isn't held while Redis answers. The commit waits for it, so it
  // isn't cut off when the invocation ends; each eviction stops at its own
  // 1.5 s timeout.
  await afterCommitAwaited(ctx.connection, () =>
    Promise.allSettled([
      evictRedisCacheForPathWithTimeout({
        path: `/api/minting-claims/${contract}/${claim}/`
      }),
      evictRedisCacheForPathWithTimeout({
        path: `/api/distributions/${contract}/${claim}/overview`
      })
    ])
  );
  return result;
}
export async function finalizeDistribution(
  contract: string,
  claim: number,
  ctx: RequestContext = {},
  manual = false
): Promise<void> {
  await dropForgePreparationRepository.run(
    contract,
    claim,
    async (_, txCtx) =>
      logDropForgeWrite(
        dropForgeNormalizeSpec({ contract, claim }),
        txCtx,
        () => populateDistributionNormalized(contract, claim, txCtx)
      ),
    ctx,
    false,
    false,
    manual ? 'MANUAL' : undefined
  );
}
