import { ethers } from 'ethers';
import { Logger } from '@/logging';

const logger = Logger.get('NFT_TRANSFER_EDGES');

const TRANSFER_IFACE = new ethers.Interface([
  'event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)',
  'event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)',
  'event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)'
]);

/** Topic hashes of the three NFT transfer events the ledger is built from. */
export const NFT_TRANSFER_TOPICS = {
  ERC721_TRANSFER: TRANSFER_IFACE.getEvent('Transfer')!.topicHash,
  ERC1155_TRANSFER_SINGLE: TRANSFER_IFACE.getEvent('TransferSingle')!.topicHash,
  ERC1155_TRANSFER_BATCH: TRANSFER_IFACE.getEvent('TransferBatch')!.topicHash
} as const;

export type NftTransferLogLike = {
  topics: readonly string[];
  data: string;
  address: string;
};

export type NftTransferEdge = {
  from: string;
  to: string;
  contract: string;
  tokenId: string;
  amount: bigint;
};

/**
 * Decodes one receipt log into zero or more NFT ownership edges. An ERC-721
 * Transfer needs four topics; the three-topic ERC-20 Transfer shares the
 * signature and is ignored. Undecodable logs yield no edges.
 */
export function extractNftTransferEdgesFromLog(
  log: NftTransferLogLike
): NftTransferEdge[] {
  try {
    if (
      log.topics.length === 4 &&
      log.topics[0] === NFT_TRANSFER_TOPICS.ERC721_TRANSFER
    ) {
      return [
        {
          from: ethers.getAddress(`0x${log.topics[1].slice(26)}`),
          to: ethers.getAddress(`0x${log.topics[2].slice(26)}`),
          contract: log.address,
          tokenId: BigInt(log.topics[3]).toString(),
          amount: BigInt(1)
        }
      ];
    }

    if (log.topics[0] === NFT_TRANSFER_TOPICS.ERC1155_TRANSFER_SINGLE) {
      const decoded = TRANSFER_IFACE.decodeEventLog(
        'TransferSingle',
        log.data,
        log.topics
      );
      return [
        {
          from: decoded.from as string,
          to: decoded.to as string,
          contract: log.address,
          tokenId: BigInt(decoded.id).toString(),
          amount: BigInt(decoded.value)
        }
      ];
    }

    if (log.topics[0] === NFT_TRANSFER_TOPICS.ERC1155_TRANSFER_BATCH) {
      const decoded = TRANSFER_IFACE.decodeEventLog(
        'TransferBatch',
        log.data,
        log.topics
      );
      const ids = decoded.ids as bigint[];
      // Ethers Result.values is an iterator method, so use the event's
      // positional values argument rather than decoded.values.
      const batchAmounts = decoded[4] as bigint[];
      return ids.map((id, index) => ({
        from: decoded.from as string,
        to: decoded.to as string,
        contract: log.address,
        tokenId: BigInt(id).toString(),
        amount: BigInt(batchAmounts[index] ?? 0)
      }));
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown decoding error';
    logger.debug(
      `[NFT_TRANSFER_LOG_PARSE_FAILED] [CONTRACT=${log.address}] [ERROR=${message}]`
    );
  }

  return [];
}

/** Ledger identity of one ownership edge inside a transaction. */
export function getNftTransferKey(
  from: string,
  to: string,
  contract: string,
  tokenId: string | number
): string {
  return [
    from.toLowerCase(),
    to.toLowerCase(),
    contract.toLowerCase(),
    BigInt(tokenId).toString()
  ].join(':');
}
