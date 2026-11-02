import { getEthereumRpcClient } from '@/ethereum-rpc/ethereum-rpc-client';
import { fetchLatestNftHistoryBlockNumber, persistNftHistoryBlock } from './db';
import { ingestHistorySources } from '@/nft-history/source-replay';

export function getAttributeChanges(
  oldAttributes: any[],
  newAttributes: any[]
) {
  const changes: any[] = [];

  const oldAttributesMap = new Map();
  oldAttributes.forEach((attribute: any) => {
    oldAttributesMap.set(attribute.trait_type, attribute.value);
  });

  const newAttributesMap = new Map();
  newAttributes.forEach((attribute: any) => {
    newAttributesMap.set(attribute.trait_type, attribute.value);
  });

  newAttributes.forEach((attribute: any) => {
    const traitType = attribute.trait_type;
    const value = attribute.value;

    if (oldAttributesMap.has(traitType)) {
      const oldValue = oldAttributesMap.get(traitType);
      if (oldValue !== value) {
        changes.push({
          trait_type: traitType,
          old_value: oldValue,
          new_value: value
        });
      }
    } else {
      changes.push({
        trait_type: `${traitType} (Added)`,
        old_value: '',
        new_value: value
      });
    }
  });

  oldAttributes.forEach((attribute: any) => {
    const traitType = attribute.trait_type;
    const value = attribute.value;

    if (!newAttributesMap.has(traitType)) {
      changes.push({
        trait_type: `${traitType} (Removed)`,
        old_value: value,
        new_value: ''
      });
    }
  });

  return changes;
}

// At 12-second blocks, five 200-block windows comfortably catch up beyond the
// 30-minute schedule while bounding creator-call discovery and receipt work.
export const HISTORY_WINDOW_BLOCKS = 200;

export async function findNFTHistory(
  force: boolean,
  startingBlock?: number,
  latestBlock?: number,
  remainingMillis: () => number = () => 900000
) {
  if (force)
    throw new Error(
      'NFT_HISTORY_RESET is unsupported; use reviewed bounded history replay'
    );
  const storedBlock =
    startingBlock ?? (await fetchLatestNftHistoryBlockNumber());
  let from = Number(storedBlock ?? 0);
  const finalized = await getEthereumRpcClient().getBlock('finalized');
  const cutoff = Math.min(latestBlock ?? finalized.number, finalized.number);
  for (
    let window = 0;
    window < 5 && from <= cutoff && remainingMillis() >= 90000;
    window++
  ) {
    const end = Math.min(from + HISTORY_WINDOW_BLOCKS - 1, cutoff);
    await ingestHistorySources(from, end, remainingMillis);
    await persistNftHistoryBlock(end);
    from = end + 1;
  }
}
