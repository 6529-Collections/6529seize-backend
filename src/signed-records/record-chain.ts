import {
  chainGatewayClient,
  ChainGatewayClient,
  chainGatewayConfigFromEnv,
  ChainGatewayError
} from '@/chain-gateway/chain-gateway.client';
import { Logger } from '@/logging';
import {
  AnchorTimeUnknownError,
  RecordAnchorHead,
  RecordAnchorSource,
  recordAnchorService
} from './record-anchor';
import {
  ChainIdentityReader,
  recordOwnerDirectory
} from './record-owner-directory';

const logger = Logger.get('SIGNED_RECORDS_CHAIN');

/**
 * Wires the chain gateway client (`ChainGatewayClient`) into signed
 * records, the anchor height and the wallets' owners together: a record
 * can't be signed or checked with one and not the other. Call it once at
 * startup of the API and of each loop that verifies records; null unwires.
 */
export function wireSignedRecordsChain(
  chain: (RecordAnchorSource & ChainIdentityReader) | null
): void {
  recordAnchorService.setSource(chain);
  recordOwnerDirectory.setChain(chain);
}

/** The client's reads signed records use. */
export type SignedRecordsGatewayReads = Pick<
  ChainGatewayClient,
  | 'getHead'
  | 'getMembershipWalletHistory'
  | 'getIdentityByWallet'
  | 'getIdentityByPrincipal'
  | 'getIdentitiesByWallets'
>;

type ChainHead = Awaited<ReturnType<SignedRecordsGatewayReads['getHead']>>;

/**
 * The finalized height a head can anchor at, with its block time: the
 * client's pin when the answering node gave its time, else that node's own
 * finalized height and time (the client pins above a node that lags), else
 * none.
 */
function finalizedOf(
  head: ChainHead
): { readonly height: number; readonly time: number } | null {
  if (head.finalizedTime !== null) {
    return { height: head.finalizedHeight, time: head.finalizedTime };
  }
  if (
    head.nodeFinalizedHeight !== undefined &&
    head.nodeFinalizedTime !== undefined
  ) {
    return { height: head.nodeFinalizedHeight, time: head.nodeFinalizedTime };
  }
  return null;
}

/**
 * The client as signed records read it: its identity reads as they are,
 * and its head as the anchor source.
 *
 * The anchor never goes back on a network: it is the highest finalized
 * height (with its block time) this source has served on the head's
 * network, kept per network as the client keeps its pin floors. A lagging
 * node's own height can be below it, and a record signed at the higher
 * anchor a moment ago must still be near the head. A head with no block
 * time at all serves that same height; with none served yet on its
 * network, it is AnchorTimeUnknownError, which the anchor service answers
 * as 503 ANCHOR_UNAVAILABLE. A new network (a relaunch) starts from its
 * own heights, and a node answering for another network and back leaves
 * each network's height where it was.
 */
export function signedRecordsChainOf(
  client: SignedRecordsGatewayReads
): RecordAnchorSource & ChainIdentityReader {
  const servedByNetwork = new Map<
    string | null,
    { readonly height: number; readonly time: number }
  >();
  return {
    getHead: async (): Promise<RecordAnchorHead> => {
      const head = await client.getHead();
      const finalized = finalizedOf(head);
      const kept = servedByNetwork.get(head.network);
      if (finalized && (!kept || finalized.height > kept.height)) {
        servedByNetwork.set(head.network, finalized);
      }
      const served = servedByNetwork.get(head.network);
      if (!served) {
        throw new AnchorTimeUnknownError();
      }
      return {
        headHeight: Math.max(head.headHeight, served.height),
        finalizedHeight: served.height,
        finalizedTime: served.time
      };
    },
    getMembershipWalletHistory: (wallet) =>
      client.getMembershipWalletHistory(wallet),
    getIdentityByWallet: (wallet, opts) =>
      client.getIdentityByWallet(wallet, opts),
    getIdentityByPrincipal: (principalId, opts) =>
      client.getIdentityByPrincipal(principalId, opts),
    getIdentitiesByWallets: (wallets, opts) =>
      client.getIdentitiesByWallets(wallets, opts)
  };
}

// The last wiring line logged: a warm container logs it once.
let lastWiringLine: string | null = null;

function logWiring(line: string, level: 'info' | 'warn'): void {
  if (line === lastWiringLine) return;
  lastWiringLine = line;
  logger[level](line);
}

/**
 * At startup of the API and of signedRecordLogLoop: wires the chain
 * gateway client in when the gateway is configured (CHAIN_GATEWAY_URL, read
 * as the client reads it). Unconfigured, nothing is wired and one line says
 * why (never the setting's value): GET /signed-records/anchor and
 * /signed-records/owners answer 503 ANCHOR_UNAVAILABLE and
 * OWNERS_UNAVAILABLE, and record submits have no anchor and no owners.
 * The line is logged once per process while the outcome stays the same.
 * Returns whether it wired.
 */
export function wireSignedRecordsChainAtStartup(
  env: Record<string, string | undefined> = process.env,
  client: SignedRecordsGatewayReads = chainGatewayClient
): boolean {
  try {
    chainGatewayConfigFromEnv(env);
  } catch (error) {
    if (error instanceof ChainGatewayError && error.code === 'not_configured') {
      wireSignedRecordsChain(null);
      logWiring(
        `[NOT WIRED] ${error.message}: signed records have no anchor height and no wallet owners`,
        'warn'
      );
      return false;
    }
    throw error;
  }
  wireSignedRecordsChain(signedRecordsChainOf(client));
  logWiring(
    '[WIRED] signed records take anchors and wallet owners from the chain gateway',
    'info'
  );
  return true;
}
