export const MAX_REPLAY_BLOCKS = 2000;
export const MAX_REPLAY_EVENTS = 25;

export interface ReplayRange {
  fromBlock: number;
  toBlock: number;
  cutoffBlock: number;
}
export type ReplayRequest = ReplayRange &
  (
    | { mode: 'nft-history-replay'; action: 'dry-run' }
    | {
        mode: 'nft-history-replay';
        action: 'apply';
        jobId: string;
        approvalDigest: string;
      }
  );

function parseRange(input: Record<string, unknown>): ReplayRange {
  for (const field of ['fromBlock', 'toBlock', 'cutoffBlock']) {
    if (
      typeof input[field] !== 'number' ||
      !Number.isSafeInteger(input[field]) ||
      input[field] < 0
    )
      throw new Error(`Invalid replay ${field}`);
  }
  const range = {
    fromBlock: Number(input.fromBlock),
    toBlock: Number(input.toBlock),
    cutoffBlock: Number(input.cutoffBlock)
  };
  if (
    range.toBlock < range.fromBlock ||
    range.toBlock > range.cutoffBlock ||
    range.toBlock - range.fromBlock + 1 > MAX_REPLAY_BLOCKS
  )
    throw new Error('Invalid or oversized replay range');
  return range;
}

function applyIdentity(input: Record<string, unknown>): {
  jobId: string;
  approvalDigest: string;
} {
  if (
    typeof input.jobId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      input.jobId
    ) ||
    typeof input.approvalDigest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(input.approvalDigest)
  )
    throw new Error('Apply requires a UUID jobId and reviewed approvalDigest');
  return { jobId: input.jobId, approvalDigest: input.approvalDigest };
}

export function parseReplayRequest(event: unknown): ReplayRequest | null {
  if (!event || typeof event !== 'object') return null;
  const input = event as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(input, 'mode')) {
    if (
      [
        'action',
        'fromBlock',
        'toBlock',
        'cutoffBlock',
        'jobId',
        'approvalDigest'
      ].some((key) => Object.prototype.hasOwnProperty.call(input, key))
    )
      throw new Error('Replay request requires an explicit mode');
    return null;
  }
  if (
    input.mode !== 'nft-history-replay' ||
    input.source === 'aws.events' ||
    !['dry-run', 'apply'].includes(String(input.action))
  )
    throw new Error('Invalid or scheduled replay invocation');
  const allowed = [
    'mode',
    'action',
    'fromBlock',
    'toBlock',
    'cutoffBlock',
    ...(input.action === 'apply' ? ['jobId', 'approvalDigest'] : [])
  ];
  if (Object.keys(input).some((key) => !allowed.includes(key)))
    throw new Error('Unexpected replay request field');
  const range = parseRange(input);
  if (input.action === 'dry-run')
    return { ...range, mode: 'nft-history-replay', action: 'dry-run' };
  return {
    ...range,
    mode: 'nft-history-replay',
    action: 'apply',
    ...applyIdentity(input)
  };
}

export function replayRange(request: ReplayRange): ReplayRange {
  return {
    fromBlock: request.fromBlock,
    toBlock: request.toBlock,
    cutoffBlock: request.cutoffBlock
  };
}
