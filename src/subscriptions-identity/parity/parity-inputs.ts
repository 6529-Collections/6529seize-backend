import { AirdropTarget } from '../engine/final-list';
import { roundSubscriptionBalance } from '../engine/parity-money';
import { AirdropTransfer } from '../engine/redemption';
import { ChainInputs, KeyMapper, run2Resolver } from './chain-inputs';
import { LegacyTopUp } from './legacy-api';
import { LegacyCsvRow, LegacyOutputs } from './legacy-outputs';
import { InputMode, ParityRun } from './parity-report';
import { BuildInputs, ParitySnapshot, toBuildInputs } from './snapshot';

export interface ParityParams {
  readonly snapshot: ParitySnapshot;
  readonly legacy: LegacyOutputs;
  readonly run: ParityRun;
  readonly buildAtMs: number;
  /** Default 'gate'. */
  readonly mode?: InputMode;
  readonly chain?: ChainInputs;
  /** Overrides the legacy outputs' airdrop mints (an Ethereum fixture). */
  readonly transfers?: readonly AirdropTransfer[];
}

/** What the engine is given, and what that leaves unchecked. */
export interface EngineInputs {
  readonly mode: InputMode;
  readonly build: BuildInputs;
  readonly mapper: KeyMapper;
  readonly resolveAirdrop: (legacyKey: string) => AirdropTarget;
  /** The airdrop rule ran (run 2), so airdrop addresses are checked. */
  readonly airdropChecked: boolean;
  /** Balances were computed, not copied, so they are checked. */
  readonly balanceChecked: boolean;
  readonly airdropSource: string;
  readonly balanceSource: string;
  readonly ties: ReadonlyMap<string, readonly string[]>;
  /** Keys the snapshot read at or after the build. */
  readonly readAfterBuild: number;
  readonly missingWallets: Set<string>;
  readonly notes: string[];
}

function topUpTimeMs(topUp: LegacyTopUp): number {
  return Date.parse(topUp.transaction_date);
}

/**
 * A key's balance at the build from its read and the top-ups dated after the
 * read and before the build, applied with the legacy top-up arithmetic. The
 * legacy loop applies a top-up a minute or so after its block, so one that
 * lands right before the build can be missing there; the comparison names
 * that as top-up timing.
 */
export function balanceAtBuild(
  readBalance: number | null,
  topUps: readonly LegacyTopUp[],
  readAtMs: number,
  buildAtMs: number
): number | null {
  let balance = readBalance;
  const applied = topUps
    .filter((t) => topUpTimeMs(t) > readAtMs && topUpTimeMs(t) < buildAtMs)
    .sort((a, b) => a.block - b.block);
  for (const topUp of applied) {
    balance =
      balance === null
        ? Number(topUp.amount)
        : roundSubscriptionBalance(balance + Number(topUp.amount));
  }
  return balance;
}

function gateBalances(params: ParityParams): Map<string, number | null> {
  const balances = new Map<string, number | null>();
  for (const subscriber of params.snapshot.subscribers) {
    balances.set(
      subscriber.key,
      balanceAtBuild(
        subscriber.details?.balance ?? null,
        params.legacy.topUps[subscriber.key] ?? [],
        subscriber.collectedAtMs,
        params.buildAtMs
      )
    );
  }
  return balances;
}

function pinnedBalances(
  legacy: LegacyOutputs,
  rows: readonly LegacyCsvRow[]
): Map<string, number | null> {
  const pinned = new Map<string, number | null>();
  for (const [key, decision] of Object.entries(legacy.buildDecisions)) {
    if (decision.kind === 'ADDED' || decision.kind === 'INSUFFICIENT_BALANCE') {
      if (Number.isFinite(decision.balance)) {
        pinned.set(key, decision.balance);
      }
    } else if (decision.kind === 'NO_BALANCE') {
      pinned.set(key, null);
    }
  }
  for (const row of rows) {
    pinned.set(row.key, row.balance);
  }
  return pinned;
}

function routeAirdrops(params: ParityParams): Map<string, string | null> {
  return new Map(
    params.snapshot.subscribers.map((s) => [
      s.key,
      s.airdrop?.airdropAddress ?? null
    ])
  );
}

function buildLineAirdrops(params: ParityParams): {
  byKey: Map<string, string | null>;
  moved: number;
} {
  const byKey = routeAirdrops(params);
  let moved = 0;
  for (const [key, decision] of Object.entries(params.legacy.buildDecisions)) {
    if (decision.kind !== 'ADDED') {
      continue;
    }
    if (byKey.has(key) && byKey.get(key) !== decision.airdropAddress) {
      moved++;
    }
    byKey.set(key, decision.airdropAddress);
  }
  return { byKey, moved };
}

/**
 * The engine's inputs for one run.
 *
 * Gate mode uses only what was read before the build: the snapshot, the
 * users' own lines dated before the build (mode, edition and card changes;
 * never the build's lines) and top-ups dated before the build. Run 1 takes
 * airdrop addresses from the legacy route as read before the build, so they
 * are not checked; run 2 runs the ported rule on the chain inputs.
 *
 * Pinned mode copies balances and run 1's airdrop addresses from the legacy
 * build's lines. It shows whether the rules reproduce the legacy results
 * from the legacy inputs, and checks neither field.
 */
export function engineInputs(
  params: ParityParams,
  listRows: readonly LegacyCsvRow[]
): EngineInputs {
  const mode = params.mode ?? 'gate';
  const mapper = new KeyMapper(params.chain?.keyMap);
  const notes: string[] = [];
  const readAfterBuild = params.snapshot.subscribers.filter(
    (s) => s.collectedAtMs >= params.buildAtMs
  ).length;
  const build = toBuildInputs(params.snapshot, {
    buildAtMs: params.buildAtMs,
    laterLogs: new Map(Object.entries(params.legacy.logs)),
    balances:
      mode === 'gate'
        ? gateBalances(params)
        : pinnedBalances(params.legacy, listRows),
    useBuildLines: mode === 'pinned'
  });

  if (params.run === 'run2') {
    if (!params.chain) {
      throw new Error('run2 needs chain inputs');
    }
    const resolver = run2Resolver(params.chain, mapper);
    return {
      mode,
      build,
      mapper,
      resolveAirdrop: resolver.resolve,
      airdropChecked: true,
      balanceChecked: mode === 'gate',
      airdropSource: `ported rule on ${params.chain.source}`,
      balanceSource:
        mode === 'gate' ? 'read before the build plus top-ups' : 'build lines',
      ties: resolver.ties,
      missingWallets: resolver.missingWallets,
      readAfterBuild,
      notes
    };
  }

  let airdrops: Map<string, string | null>;
  let airdropSource: string;
  if (mode === 'pinned') {
    const pinned = buildLineAirdrops(params);
    airdrops = pinned.byKey;
    airdropSource = 'legacy build lines';
    if (pinned.moved) {
      notes.push(`airdrop route moved after the build: ${pinned.moved} keys`);
    }
  } else {
    airdrops = routeAirdrops(params);
    airdropSource = 'legacy route, read before the build';
  }
  return {
    mode,
    build,
    mapper,
    resolveAirdrop: (key) => ({
      airdropAddress: airdrops.get(key) ?? null,
      tdhWallet: null
    }),
    airdropChecked: false,
    balanceChecked: mode === 'gate',
    airdropSource,
    balanceSource:
      mode === 'gate' ? 'read before the build plus top-ups' : 'build lines',
    ties: new Map(),
    missingWallets: new Set(),
    readAfterBuild,
    notes
  };
}
