import type { NativeClaimContext } from '@/competitions/competition-event.repository';
import { MEMES_CONTRACT } from '@/constants';
import { env } from '@/env';
import {
  mintingClaimsService,
  MintingClaimsService
} from '@/minting-claims/minting-claims.service';
import { getMintGateway, MintGatewayPort } from './mint-gateway';
import { MintLogRecorder, mintLogRecorder } from './mint-log-recorder';
import { mintCard } from './mint-log-parts';

/**
 * Once the chain counts the Main Stage, the chain index queues the claim
 * build for a final result of a decision listed in MAIN_STAGE_DECISION_IDS,
 * with the result's reference. The claim's log entry keeps that reference.
 */
export interface ChainClaimContext {
  readonly decision_id: string;
  readonly occurrence: number;
  readonly entry_id: string;
  readonly height: number;
  readonly manifest_hash: string;
}

const HEX_ID = /^0x[0-9a-f]{64}$/;

/**
 * The chain decisions that are the Main Stage. The chain has no Main Stage
 * designation yet, so this setting names them; every reader uses it.
 */
export function mainStageDecisionIds(): string[] {
  return env
    .getStringArray('MAIN_STAGE_DECISION_IDS', ',')
    .map((id) => id.trim().toLowerCase())
    .filter((id) => id.length > 0);
}

export function parseChainClaimContext(value: unknown): ChainClaimContext {
  const chain = value as Partial<ChainClaimContext> | null;
  if (
    !chain ||
    typeof chain.decision_id !== 'string' ||
    !HEX_ID.test(chain.decision_id) ||
    typeof chain.entry_id !== 'string' ||
    !HEX_ID.test(chain.entry_id) ||
    typeof chain.manifest_hash !== 'string' ||
    !HEX_ID.test(chain.manifest_hash) ||
    !Number.isSafeInteger(chain.occurrence) ||
    (chain.occurrence as number) < 0 ||
    !Number.isSafeInteger(chain.height) ||
    (chain.height as number) <= 0
  ) {
    throw new Error('Invalid chain claim context');
  }
  return {
    decision_id: chain.decision_id,
    occurrence: chain.occurrence as number,
    entry_id: chain.entry_id,
    height: chain.height as number,
    manifest_hash: chain.manifest_hash
  };
}

/**
 * Checks the result on the gateway when one is bound: the result must be
 * final and its rank 1 must be this entry with this manifest. A failed check
 * throws, so the message goes back to the queue rather than building a claim
 * the chain did not pick. Without a gateway the entry says `unverified`.
 */
export async function verifyChainClaim(
  chain: ChainClaimContext,
  gateway: MintGatewayPort | null,
  mainStage: readonly string[] = mainStageDecisionIds()
): Promise<'verified' | 'unverified'> {
  if (!mainStage.includes(chain.decision_id)) {
    throw new Error(
      `Decision ${chain.decision_id} is not in MAIN_STAGE_DECISION_IDS`
    );
  }
  if (!gateway) return 'unverified';
  const result = await gateway.decisionResult(
    chain.decision_id,
    chain.occurrence
  );
  const first = result?.winners.find((winner) => winner.rank === 1);
  if (
    result?.state !== 'FINAL' ||
    !first ||
    first.entry_id !== chain.entry_id ||
    first.manifest_hash !== chain.manifest_hash
  ) {
    throw new Error(
      `Decision ${chain.decision_id} occurrence ${chain.occurrence} did not pick entry ${chain.entry_id}`
    );
  }
  return 'verified';
}

/** Builds the claim for a Main Stage winner as one logged service write. */
export async function buildClaimLogged(
  args: {
    readonly dropId: string;
    readonly competition?: NativeClaimContext;
    readonly chain?: ChainClaimContext;
  },
  deps: {
    readonly recorder: MintLogRecorder;
    readonly claims: MintingClaimsService;
    readonly gateway: MintGatewayPort | null;
    readonly mainStage: readonly string[];
  } = {
    recorder: mintLogRecorder,
    claims: mintingClaimsService,
    gateway: getMintGateway(),
    mainStage: mainStageDecisionIds()
  }
): Promise<void> {
  const verification = args.chain
    ? await verifyChainClaim(args.chain, deps.gateway, deps.mainStage)
    : null;
  await deps.recorder.write(
    {
      kind: 'claim.built',
      card: async (connection) =>
        mintCard(
          MEMES_CONTRACT,
          await deps.claims.claimIdForDrop(args.dropId, { connection })
        ),
      actor: { type: 'service', wallet: null, authority: 'main-stage-result' },
      intent: {
        route: 'SQS claims-builder',
        params: { drop_id: args.dropId },
        body: {
          competition: args.competition ?? null,
          chain: args.chain ?? null
        }
      },
      inputs: async () => ({
        chain_result: args.chain ? { ...args.chain, check: verification } : null
      })
    },
    () => deps.claims.createClaimForDropIfMissing(args.dropId, args.competition)
  );
}
