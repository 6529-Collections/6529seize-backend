import { ethers } from 'ethers';
import {
  Alchemy,
  AssetTransfersCategory,
  AssetTransfersWithMetadataParams,
  SortingOrder
} from 'alchemy-sdk';
import { Logger } from '../logging';
import { NEXTGEN_MINTER_IFACE } from '../abis/nextgen';
import { NextGenLog } from '../entities/INextGen';
import { Time } from '../time';
import {
  fetchNextGenCollection,
  persistNextGenCollection,
  persistNextGenLogs
} from './nextgen.db';
import { EntityManager } from 'typeorm';
import {
  getNextgenNetwork,
  NEXTGEN_MINTER_CONTRACT
} from './nextgen_constants';
import { getEns } from '../alchemy';
import { ethTools } from '../eth-tools';

const logger = Logger.get('NEXTGEN_MINTER');

export async function findMinterTransactions(
  entityManager: EntityManager,
  alchemy: Alchemy,
  startBlock: number,
  endBlock: number,
  pageKey?: string
) {
  const network = getNextgenNetwork();
  logger.info(
    `[NETWORK ${network}] : [FINDING TRANSACTIONS] : [START BLOCK ${startBlock}] : [END BLOCK ${endBlock}] : [PAGE KEY ${pageKey}]`
  );
  const settings: AssetTransfersWithMetadataParams = {
    category: [AssetTransfersCategory.EXTERNAL],
    excludeZeroValue: false,
    maxCount: 100,
    fromBlock: `0x${startBlock.toString(16)}`,
    toBlock: `0x${endBlock.toString(16)}`,
    pageKey: pageKey,
    toAddress: NEXTGEN_MINTER_CONTRACT[network],
    withMetadata: true,
    order: SortingOrder.ASCENDING
  };
  const response = await alchemy.core.getAssetTransfers(settings);

  const logs: NextGenLog[] = [];
  for (const transfer of response.transfers) {
    const receipt = await alchemy.core.getTransaction(transfer.hash);
    if (receipt) {
      const parsedReceipt = NEXTGEN_MINTER_IFACE.parseTransaction({
        data: receipt.data,
        value: 0
      })!;
      const methodName = parsedReceipt.name;
      const args = parsedReceipt.args;
      const processedLogs = await processLog(entityManager, methodName, args);
      const timestamp = new Date(transfer.metadata.blockTimestamp);
      processedLogs.forEach((processedLog, index) => {
        const l: NextGenLog = {
          id: `${transfer.hash}-${index}`,
          transaction: transfer.hash,
          block: parseInt(transfer.blockNum, 16),
          block_timestamp: timestamp.getTime() / 1000,
          collection_id: processedLog.id,
          heading: processedLog.title,
          log: processedLog.description,
          source: 'minter'
        };
        logs.push(l);
      });
    }
  }

  await persistNextGenLogs(entityManager, logs);

  if (response.pageKey) {
    await findMinterTransactions(
      entityManager,
      alchemy,
      startBlock,
      endBlock,
      response.pageKey
    );
  }
}

export async function processLog(
  entityManager: EntityManager,
  methodName: string,
  args: ethers.Result
): Promise<
  {
    id: number;
    title: string;
    description: string;
  }[]
> {
  switch (methodName) {
    case 'initializeBurn':
      return await initializeBurn(entityManager, args);
    case 'initializeExternalBurnOrSwap':
      return await initializeExternalBurnOrSwap(args);
    case 'setCollectionCosts':
      return await setCollectionCosts(args);
    case 'setCollectionPhases':
      return await setCollectionPhases(entityManager, args);
    case 'mint':
    case 'airDropTokens':
      // skip - handled by core_events
      return [];
    case 'burnOrSwapExternalToMint':
    case 'burnToMint':
      // skip - handled by Transfer
      return [];
    case 'payArtist':
      return await payArtist(args);
    case 'setPrimaryAndSecondarySplits':
      return await setPrimaryAndSecondarySplits(args);
    case 'acceptAddressesAndPercentages':
      return await acceptAddressesAndPercentages(args);
    case 'proposePrimaryAddressesAndPercentages':
      return await proposeAddressesAndPercentages('Primary', args);
    case 'proposeSecondaryAddressesAndPercentages':
      return await proposeAddressesAndPercentages('Secondary', args);
    case 'updateCoreContract':
      return await updateCoreContract(args);
  }

  const methodNameParts = methodName
    .replace(/([A-Z])/g, ' $1')
    .trim()
    .split(' ');
  methodNameParts[0] =
    methodNameParts[0].charAt(0).toUpperCase() + methodNameParts[0].slice(1);

  return [
    {
      id: 0,
      title: methodNameParts.join(' '),
      description: ''
    }
  ];
}

async function initializeBurn(
  entityManager: EntityManager,
  args: ethers.Result
): Promise<
  {
    id: number;
    title: string;
    description: string;
  }[]
> {
  const burnCollectionId = parseInt(args[0]);
  const mintCollectionId = parseInt(args[1]);
  const status: boolean = args[2];

  const burnCollection = await fetchNextGenCollection(
    entityManager,
    burnCollectionId
  );
  const mintCollection = await fetchNextGenCollection(
    entityManager,
    mintCollectionId
  );

  if (!burnCollection || !mintCollection) {
    logger.info(
      `[METHOD NAME INITIALIZE BURN] : [COLLECTION ID ${burnCollectionId} OR ${mintCollectionId} NOT FOUND]`
    );
    return [];
  }

  let title = 'Burn';
  if (status) {
    title += ` Initialized`;
  } else {
    title += ` Deactivated`;
  }

  const description = `Burn Collection #${burnCollectionId} - ${burnCollection.name} / Mint Collection #${mintCollectionId} - ${mintCollection.name}`;

  return [
    {
      id: mintCollectionId,
      title: title,
      description: description
    }
  ];
}

async function initializeExternalBurnOrSwap(args: ethers.Result): Promise<
  {
    id: number;
    title: string;
    description: string;
  }[]
> {
  const burnCollection = args[0];
  const burnCollectionId = parseInt(args[1]);
  const mintCollectionId = parseInt(args[2]);
  const tokenMin = parseInt(args[3]);
  const tokenMax = parseInt(args[4]);
  const burnAddress = args[5];
  const status: boolean = args[6];

  let title = 'External Burn or Swap';
  if (status) {
    title += ` Initialized`;
  } else {
    title += ` Deactivated`;
  }

  const description = `Burn Collection ${burnCollection} ${
    burnCollectionId ? `(ID ${burnCollectionId})` : ''
  } for tokens ${tokenMin} - ${tokenMax} (Burn Address ${burnAddress})`;

  return [
    {
      id: mintCollectionId,
      title: title,
      description: description
    }
  ];
}

async function setCollectionCosts(args: ethers.Result): Promise<
  {
    id: number;
    title: string;
    description: string;
  }[]
> {
  const collectionId = parseInt(args[0]);
  const mintCost = parseInt(args[1]);
  const endMintCost = parseInt(args[2]);
  const rate = parseInt(args[3]);
  const timePeriod = parseInt(args[4]);
  const salesOption = parseInt(args[5]);
  // const delAddress = args[6];

  let salesOptionDescription = '';

  const timePeriodTime = Time.seconds(timePeriod);
  const timePeriodDescription = timePeriodTime.formatAsDuration();

  switch (salesOption) {
    case 1:
      salesOptionDescription = 'Fixed Price';
      break;
    case 2:
      if (rate === 0) {
        salesOptionDescription = `Exponential Descending (Time Period: ${timePeriodDescription})`;
      } else {
        salesOptionDescription = `Linear Descending (Time Period: ${timePeriodDescription})`;
      }
      break;
    case 3:
      salesOptionDescription = `Periodic Sale (Time Period: ${timePeriodDescription})`;
      break;
    default:
      salesOptionDescription = `${salesOption}`;
  }

  const mintCostDescription = `Mint Cost: ${
    mintCost > 0 ? `${ethTools.weiToEth(mintCost)} ETH` : 'Free'
  }`;
  const endMintCosetDescription = `End Mint Cost: ${
    endMintCost > 0 ? `${ethTools.weiToEth(endMintCost)} ETH` : 'Free'
  }`;

  return [
    {
      id: collectionId,
      title: 'Collection Costs Set',
      description: `Sales Model: ${salesOptionDescription}, ${mintCostDescription}, ${endMintCosetDescription}`
    }
  ];
}

async function setCollectionPhases(
  entityManager: EntityManager,
  args: ethers.Result
): Promise<
  {
    id: number;
    title: string;
    description: string;
  }[]
> {
  const id = parseInt(args[0]);
  const alStart = parseInt(args[1]);
  const alEnd = parseInt(args[2]);
  const publicStart = parseInt(args[3]);
  const publicEnd = parseInt(args[4]);
  const merkleRoot = args[5];

  const collection = await fetchNextGenCollection(entityManager, id);
  if (!collection) {
    logger.info(
      `[METHOD NAME SET COLLECTION PHASES] : [COLLECTION ID ${id} NOT FOUND]`
    );
    return [];
  }
  collection.allowlist_start = alStart;
  collection.allowlist_end = alEnd;
  collection.public_start = publicStart;
  collection.public_end = publicEnd;
  collection.merkle_root = merkleRoot;

  await persistNextGenCollection(entityManager, collection);

  let allowListLog = 'n/a';
  if (alStart > 0 && alEnd > 0) {
    allowListLog = `${Time.millis(
      alStart * 1000
    ).toIsoDateTimeString()} - ${Time.millis(
      alEnd * 1000
    ).toIsoDateTimeString()}`;
  }

  let publicLog = 'n/a';
  if (publicStart > 0 && publicEnd > 0) {
    publicLog = `${Time.millis(
      publicStart * 1000
    ).toIsoDateTimeString()} - ${Time.millis(
      publicEnd * 1000
    ).toIsoDateTimeString()}`;
  }

  const log = `Allowlist: ${allowListLog}, Public: ${publicLog}`;
  return [
    {
      id: id,
      title: 'Collection Phases Set',
      description: log
    }
  ];
}

async function payArtist(args: ethers.Result): Promise<
  {
    id: number;
    title: string;
    description: string;
  }[]
> {
  const collectionId = parseInt(args[0]);
  const _team1 = args[1];
  const _team2 = args[2];
  const _teamperc1 = parseInt(args[3]);
  const _teamperc2 = parseInt(args[4]);

  const title = 'Pay Artist';
  let teamLog = '';
  if (_teamperc1 > 0 || _teamperc2 > 0) {
    teamLog += ' - Team: ';
  }
  if (_teamperc1 > 0) {
    teamLog += `${_teamperc1}% to ${_team1}`;
  }
  if (_teamperc2 > 0) {
    teamLog += `${_teamperc1 > 0 ? ', ' : ''}${_teamperc2}% to ${_team2}`;
  }

  const artistPerc = 100 - _teamperc1 - _teamperc2;
  const log = `Artist: ${artistPerc}%${teamLog}`;

  return [
    {
      id: collectionId,
      title: title,
      description: log
    }
  ];
}

async function setPrimaryAndSecondarySplits(args: ethers.Result): Promise<
  {
    id: number;
    title: string;
    description: string;
  }[]
> {
  const collectionId = parseInt(args[0]);
  const _artistPrSplit = parseInt(args[1]);
  const _teamPrSplit = parseInt(args[2]);
  const _artistSecSplit = parseInt(args[3]);
  const _teamSecSplit = parseInt(args[4]);

  const log = `Primary: Artist ${_artistPrSplit}% / Team ${_teamPrSplit}% - Secondary: Artist ${_artistSecSplit}% / Team ${_teamSecSplit}%`;

  return [
    {
      id: collectionId,
      title: 'Primary and Secondary Splits Set',
      description: log
    }
  ];
}

async function acceptAddressesAndPercentages(args: ethers.Result): Promise<
  {
    id: number;
    title: string;
    description: string;
  }[]
> {
  const collectionId = parseInt(args[0]);
  const primary: boolean = args[1];
  const secondary: boolean = args[2];

  const primaryLog = primary ? 'Accepted' : 'Rejected';
  const secondaryLog = secondary ? 'Accepted' : 'Rejected';

  return [
    {
      id: collectionId,
      title: 'Addresses and Percentages',
      description: `Primary: ${primaryLog}, Secondary: ${secondaryLog}`
    }
  ];
}

async function proposeAddressesAndPercentages(
  type: 'Primary' | 'Secondary',
  args: ethers.Result
): Promise<
  {
    id: number;
    title: string;
    description: string;
  }[]
> {
  const collectionId = parseInt(args[0]);
  const add1 = args[1];
  const add2 = args[2];
  const add3 = args[3];
  const add1Ens = await getEns(add1);
  const add2Ens = await getEns(add2);
  const add3Ens = await getEns(add3);
  const _add1Percentage = parseInt(args[4]);
  const _add2Percentage = parseInt(args[5]);
  const _add3Percentage = parseInt(args[6]);

  const getAddressLog = (address: string, ens: string | null) => {
    if (ens) {
      return ens + ' (' + address + ')';
    } else {
      return address;
    }
  };

  const getLog = (percentage: number, address: string, ens: string | null) =>
    `${percentage}% to ${getAddressLog(address, ens)}`;

  let log = '';
  if (_add1Percentage > 0) {
    log += getLog(_add1Percentage, add1, add1Ens);
  }
  if (_add2Percentage > 0) {
    if (log) {
      log += ' - ';
    }
    log += getLog(_add2Percentage, add2, add2Ens);
  }
  if (_add3Percentage > 0) {
    if (log) {
      log += ' - ';
    }
    log += getLog(_add3Percentage, add3, add3Ens);
  }

  return [
    {
      id: collectionId,
      title: `${type} Addresses and Percentages Proposed`,
      description: log
    }
  ];
}

async function updateCoreContract(args: ethers.Result): Promise<
  {
    id: number;
    title: string;
    description: string;
  }[]
> {
  const newCoreContract = args[0];

  return [
    {
      id: 0,
      title: 'Core Contract Updated',
      description: `Minter's Core Contract Updated to ${newCoreContract}`
    }
  ];
}
