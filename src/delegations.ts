import { Alchemy, Log, Network } from '@/alchemy-sdk';
import {
  DELEGATION_ALL_ADDRESS,
  DELEGATION_CONTRACT,
  MEMES_CONTRACT,
  USE_CASE_CONSOLIDATION,
  USE_CASE_PRIMARY_ADDRESS,
  USE_CASE_SUB_DELEGATION
} from '@/constants';
import {
  createDelegationStateReader,
  RegistrationLogRef,
  resolveRegistrationExpiries,
  RevocationLogRef
} from '@/delegation-registration-expiry';
import { MAX_STORABLE_DELEGATION_TOKEN_ID } from '@/delegation-row';
import { LogDescription } from 'ethers';
import { DELEGATIONS_IFACE } from './abis/delegations';
import {
  ConsolidationEvent,
  DelegationEvent,
  Event,
  EventType
} from './entities/IDelegation';
import { Logger } from './logging';
import { getAlchemyInstance } from './alchemy';
import { sepolia } from '@wagmi/chains';
import { equalIgnoreCase } from './strings';

let alchemy: Alchemy;

const logger = Logger.get('DELEGATIONS');

const REGISTER_EVENTS = [
  'RegisterDelegation',
  'RegisterDelegationUsingSubDelegation'
];
const REVOKE_EVENTS = [
  'RevokeDelegation',
  'RevokeDelegationUsingSubDelegation'
];

async function getAllDelegations(startingBlock: number, latestBlock: number) {
  const startingBlockHex = `0x${startingBlock.toString(16)}`;
  const latestBlockHex = `0x${latestBlock.toString(16)}`;

  logger.info(`[FROM BLOCK ${startingBlockHex}] [TO BLOCK ${latestBlockHex}]`);

  const response = await alchemy.core.getLogs({
    address: DELEGATION_CONTRACT.contract,
    fromBlock: startingBlockHex,
    toBlock: latestBlockHex
  });
  return response;
}

interface PendingRegistration {
  event: DelegationEvent;
  ref: RegistrationLogRef;
}

interface DelegationScan {
  consolidations: ConsolidationEvent[];
  registrations: DelegationEvent[];
  revocations: DelegationEvent[];
  pendingRegistrations: PendingRegistration[];
  revocationRefs: RevocationLogRef[];
}

interface DelegationLog {
  log: Log;
  parsed: LogDescription;
  from: string;
  to: string;
  collection: string;
  useCase: number;
}

function isConsolidationCollection(collection: string) {
  return [MEMES_CONTRACT, DELEGATION_ALL_ADDRESS].includes(collection);
}

function collectRegistration(entry: DelegationLog, scan: DelegationScan) {
  const { log, parsed, from, to, collection, useCase } = entry;
  const e: Event = {
    block: log.blockNumber,
    type: EventType.REGISTER,
    wallet1: from,
    wallet2: to
  };
  if (useCase == USE_CASE_CONSOLIDATION) {
    if (isConsolidationCollection(collection)) {
      scan.consolidations.push(e);
    }
    return;
  }
  if (useCase == USE_CASE_SUB_DELEGATION) {
    scan.registrations.push({
      ...e,
      use_case: useCase,
      collection: collection
    });
    return;
  }
  const allTokens = Boolean(parsed.args.allTokens);
  // The contract stores token 0 for all-token delegations.
  const tokenId = allTokens ? BigInt(0) : BigInt(parsed.args._tokenId);
  if (tokenId > MAX_STORABLE_DELEGATION_TOKEN_ID) {
    // Any caller can pick the token id. One the token_id column cannot hold
    // would fail the insert, or be stored as a different token, so it is
    // skipped rather than stalling the loop or widening the delegation.
    logger.warn(
      `[SKIPPING REGISTRATION] [TOKEN ID ${tokenId} DOES NOT FIT token_id] [BLOCK ${log.blockNumber}] [LOG ${log.logIndex}]`
    );
    return;
  }
  const registration: DelegationEvent = {
    ...e,
    use_case: useCase,
    collection: collection,
    all_tokens: allTokens,
    token_id: Number(tokenId)
  };
  // The same object is held in registrations and pendingRegistrations:
  // attachRegistrationExpiries sets its expiry and filters by identity.
  scan.registrations.push(registration);
  scan.pendingRegistrations.push({
    event: registration,
    ref: {
      block: log.blockNumber,
      logIndex: log.logIndex,
      delegator: from,
      collection,
      delegate: to,
      useCase,
      allTokens,
      tokenId
    }
  });
}

function collectRevocation(entry: DelegationLog, scan: DelegationScan) {
  const { log, from, to, collection, useCase } = entry;
  const e: Event = {
    block: log.blockNumber,
    type: EventType.REVOKE,
    wallet1: from,
    wallet2: to
  };
  if (useCase == USE_CASE_CONSOLIDATION) {
    if (isConsolidationCollection(collection)) {
      scan.consolidations.push(e);
    }
    return;
  }
  scan.revocations.push({
    ...e,
    use_case: useCase,
    collection: collection
  });
  scan.revocationRefs.push({
    block: log.blockNumber,
    logIndex: log.logIndex,
    delegator: from,
    collection,
    delegate: to,
    useCase
  });
}

function collectLog(log: Log, scan: DelegationScan) {
  const parsed = DELEGATIONS_IFACE.parseLog(log);
  if (!parsed) {
    return;
  }
  const entry: DelegationLog = {
    log,
    parsed,
    from: parsed.args.delegator ? parsed.args.delegator : parsed.args.from,
    to: parsed.args.delegationAddress,
    collection: parsed.args.collectionAddress,
    useCase: Number(parsed.args.useCase)
  };
  if (
    equalIgnoreCase(entry.from, entry.to) &&
    entry.useCase !== USE_CASE_PRIMARY_ADDRESS
  ) {
    return;
  }
  if (REGISTER_EVENTS.includes(parsed.name)) {
    collectRegistration(entry, scan);
  } else if (REVOKE_EVENTS.includes(parsed.name)) {
    collectRevocation(entry, scan);
  }
}

// allTokens and the token id come from the event. The expiry is not in the
// event, so it is read from contract state at the event's block; decoding the
// transaction input instead misses Safe-signed and batched registrations.
// A failed read throws before anything is persisted, and the delegations loop
// retries the scan. Registrations revoked later in the same block are dropped.
async function attachRegistrationExpiries(
  scan: DelegationScan
): Promise<DelegationEvent[]> {
  const { registrations, pendingRegistrations: pending } = scan;
  if (pending.length === 0) {
    return registrations;
  }
  const expiries = await resolveRegistrationExpiries(
    pending.map((p) => p.ref),
    scan.revocationRefs,
    createDelegationStateReader(
      (to, data, blockTag) => alchemy.core.call({ to, data }, blockTag),
      DELEGATION_CONTRACT.contract
    )
  );
  const revoked = new Set<DelegationEvent>();
  pending.forEach(({ event }, index) => {
    const expiry = expiries[index];
    if (expiry === null) {
      revoked.add(event);
    } else {
      event.expiry = expiry;
    }
  });
  if (revoked.size > 0) {
    logger.info(
      `[SKIPPING ${revoked.size} REGISTRATIONS REVOKED IN THE SAME BLOCK]`
    );
  }
  return registrations.filter((r) => !revoked.has(r));
}

const getNetwork = () => {
  if (DELEGATION_CONTRACT.chain_id == sepolia.id) {
    return Network.ETH_SEPOLIA;
  }
  return Network.ETH_MAINNET;
};

export const findDelegationTransactions = async (
  startingBlock: number,
  latestBlock?: number
) => {
  const network = getNetwork();
  alchemy = getAlchemyInstance(network);

  if (!latestBlock) {
    latestBlock = await alchemy.core.getBlockNumber();
    logger.info(
      `[STARTING BLOCK ${startingBlock}] [LATEST BLOCK ON CHAIN ${latestBlock}]`
    );
  }

  const timestamp = (await alchemy.core.getBlock(latestBlock)).timestamp;

  const allDelegations = await getAllDelegations(startingBlock, latestBlock);

  logger.info(`[FOUND ${allDelegations.length} NEW TRANSACTIONS]`);

  const scan: DelegationScan = {
    consolidations: [],
    registrations: [],
    revocations: [],
    pendingRegistrations: [],
    revocationRefs: []
  };
  for (const d of allDelegations) {
    collectLog(d, scan);
  }

  const registrations = await attachRegistrationExpiries(scan);

  return {
    latestBlock: latestBlock,
    latestBlockTimestamp: timestamp,
    consolidations: scan.consolidations,
    registrations: registrations,
    revocation: scan.revocations
  };
};
