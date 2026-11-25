/**
 * NFTDelegation cutoff for the move of identities to the 6529 chain.
 *
 * At the identity freeze (Tue 24 Nov 2026 00:00 UTC) the chain imports
 * NFTDelegation's consolidations and delegations as they stand at B_T, the
 * last Ethereum block before the freeze (the cutoff block of that TDH day).
 * From then on NFTDelegation registrations and revocations no longer count
 * for 6529: the delegations loop keeps reading the contract's logs and
 * stores the ones after B_T for the record, but applies none of them to
 * the delegations and consolidations tables, primary addresses or
 * consolidated TDH.
 *
 * Configuration (either is enough; the block wins when both are set):
 * - NFTDELEGATION_FREEZE_BLOCK: B_T itself, once it is known.
 * - IDENTITY_FREEZE_AT: the freeze time T (ISO 8601 UTC such as
 *   `2026-11-24T00:00:00Z`, or Unix milliseconds). B_T is then the block b
 *   with ts(b) < T <= ts(b + 1), found when the chain head reaches T. This
 *   can be set before the freeze, so nothing after B_T is applied even if
 *   the loop runs seconds after T.
 * A value that cannot be read stops the loop: applying events past the
 * freeze cannot be undone, stopping can.
 */
export const NFTDELEGATION_FREEZE_BLOCK_ENV = 'NFTDELEGATION_FREEZE_BLOCK';
export const IDENTITY_FREEZE_AT_ENV = 'IDENTITY_FREEZE_AT';

export type NftDelegationFreeze =
  | { readonly kind: 'NONE' }
  | { readonly kind: 'BLOCK'; readonly block: number }
  | { readonly kind: 'TIME'; readonly atSeconds: number };

const ISO_UTC =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]00:00)$/;

function readFreezeAtSeconds(raw: string): number {
  if (/^\d{1,16}$/.test(raw)) {
    return Math.ceil(Number(raw) / 1000);
  }
  if (ISO_UTC.test(raw)) {
    const millis = Date.parse(raw);
    if (Number.isFinite(millis)) {
      return Math.ceil(millis / 1000);
    }
  }
  throw new Error(
    `${IDENTITY_FREEZE_AT_ENV} must be an ISO 8601 UTC time or Unix milliseconds, got "${raw}"`
  );
}

export function readNftDelegationFreeze(
  env: Record<string, string | undefined> = process.env
): NftDelegationFreeze {
  const block = env[NFTDELEGATION_FREEZE_BLOCK_ENV]?.trim();
  if (block) {
    if (!/^\d{1,12}$/.test(block) || Number(block) <= 0) {
      throw new Error(
        `${NFTDELEGATION_FREEZE_BLOCK_ENV} must be a positive block number, got "${block}"`
      );
    }
    return { kind: 'BLOCK', block: Number(block) };
  }
  const at = env[IDENTITY_FREEZE_AT_ENV]?.trim();
  if (at) {
    return { kind: 'TIME', atSeconds: readFreezeAtSeconds(at) };
  }
  return { kind: 'NONE' };
}

export interface ChainHead {
  readonly block: number;
  readonly timestamp: number;
}

/**
 * The last block before T: b with ts(b) < T <= ts(b + 1), given a head at or
 * after T. Block timestamps strictly increase, so this is a binary search;
 * it first walks back from an estimate (12 s blocks) until it is below T.
 */
export async function findLastBlockBefore(
  atSeconds: number,
  head: ChainHead,
  timestampOf: (block: number) => Promise<number>
): Promise<number> {
  if (head.timestamp < atSeconds) {
    throw new Error(
      `The head ${head.block} (${head.timestamp}) is before the freeze time ${atSeconds}`
    );
  }
  let high = head.block;
  let step = Math.max(1, Math.ceil((head.timestamp - atSeconds) / 12) + 8);
  let low = Math.max(0, high - step);
  while (low > 0 && (await timestampOf(low)) >= atSeconds) {
    high = low;
    step *= 2;
    low = Math.max(0, low - step);
  }
  if (low === 0 && (await timestampOf(0)) >= atSeconds) {
    throw new Error(`No block before the freeze time ${atSeconds}`);
  }
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if ((await timestampOf(middle)) < atSeconds) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return low;
}

/** B_T for this run, or null when no freeze applies yet. */
export async function resolveFreezeBlock(
  freeze: NftDelegationFreeze,
  head: ChainHead,
  timestampOf: (block: number) => Promise<number>
): Promise<number | null> {
  switch (freeze.kind) {
    case 'NONE':
      return null;
    case 'BLOCK':
      return freeze.block;
    case 'TIME':
      if (head.timestamp < freeze.atSeconds) {
        return null;
      }
      return await findLastBlockBefore(freeze.atSeconds, head, timestampOf);
  }
}

export interface BlockRange {
  readonly from: number;
  readonly to: number;
}

/**
 * Splits a scan of [start, latest] at the freeze block: what is applied (at
 * or before it) and what is only recorded (after it).
 */
export function splitAtFreeze(
  start: number,
  latest: number,
  freezeBlock: number | null
): { apply: BlockRange | null; record: BlockRange | null } {
  if (latest < start) {
    return { apply: null, record: null };
  }
  if (freezeBlock === null || latest <= freezeBlock) {
    return { apply: { from: start, to: latest }, record: null };
  }
  if (start > freezeBlock) {
    return { apply: null, record: { from: start, to: latest } };
  }
  return {
    apply: { from: start, to: freezeBlock },
    record: { from: freezeBlock + 1, to: latest }
  };
}
