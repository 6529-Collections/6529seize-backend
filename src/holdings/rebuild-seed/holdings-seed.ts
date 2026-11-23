import { Interface, parseEther, toBeHex, zeroPadValue } from 'ethers';
import {
  GRADIENT_CONTRACT,
  MEMELAB_CONTRACT,
  MEMES_CONTRACT,
  NULL_ADDRESS
} from '@/constants';
import { MANIFOLD_LAZY_CLAIM_CONTRACT } from '@/constants/manifold';
import { Network } from '@/ethereum-rpc/ethereum-rpc-network';
import { Logger } from '@/logging';
import { rebuildNftHistoryStep } from '@/nft-history/history-rebuild';
import { rebuildNextGen } from '@/nextgen/nextgen-rebuild';
import {
  NEXTGEN_CORE_CONTRACT,
  NEXTGEN_MINTER_CONTRACT
} from '@/nextgen/nextgen_constants';
import { RebuildContext } from '@/rebuild/manifest.types';
import { PROBE_WALLETS } from '@/rebuild/manifests/probe-fixture';
import { rebuildWalletTransferAnalysis } from '@/wallet-transfer-analysis/wallet-transfer-rebuild';
import {
  rebuildHoldingsBalances,
  rebuildNftCatalogue,
  rebuildNftOwners,
  rebuildTransactions
} from '../ethereum-index-rebuild';
import {
  readMemeLabRoyalties,
  rebuildMemeLabRoyalties
} from '../meme-lab-royalties-rebuild';
import { SEED_CLAIM_RUNTIME } from './seed-claim.runtime';
import { SEED_CREATOR_RUNTIME } from './seed-creator.runtime';
import {
  SEED_ARTIST,
  SEED_FILES,
  seedTokenUri,
  writeSeedFiles
} from './seed-metadata';
import {
  SEED_NEXTGEN_CORE_RUNTIME,
  SEED_NEXTGEN_MINTER_RUNTIME
} from './seed-nextgen.runtime';

const logger = Logger.get('HOLDINGS_SEED');

/**
 * The rebuild check's seed for the holdings probes (step `holdings.seed`).
 * It writes the probe fixture's world on the run's private anvil, then
 * fills the holdings tables from it with the loops' own code, as the
 * rebuild steps do after the drop.
 *
 * The contracts on that chain are test fixtures written for this
 * repository: SeedCreator.sol stands for Manifold's ERC-1155 creator
 * contracts, SeedClaim.sol for Manifold's ERC-1155 lazy claim extension,
 * and SeedNextGen.sol for the NextGen core and minter. Each keeps only the
 * function signatures, events and view layout the loops read, and sits at
 * the address the loops read from this repository's constants. Only this
 * seed loads them, and only into the check's own anvil; the loops under
 * test are the real ones, unchanged. The way to drop them is a recorded
 * slice of mainnet (`--source ethereum=replay:<dir>`) or an anvil state
 * holding the real contracts (`anvil:<state file>`), each made once with a
 * live RPC. With either, the chain-writing half of this seed
 * (writeSeedChain) goes, and the rebuild steps stay as they are.
 *
 * On anvil, through the ethereum source:
 * - SeedCreator's code at the Memes, Meme Lab and Gradient addresses;
 * - Memes cards 1, 2 and 3 of season 1, each made by the admin with
 *   mintBaseNew (a season needs three cards: the balances code's card-set
 *   count fails on fewer); card 1 to wallet 1, card 2 to wallet 2, card 3
 *   to wallet 1;
 * - a paid mint each: wallet 2 of card 1 and wallet 1 of card 2;
 * - a transfer each way: wallet 1 sends card 3 to wallet 2, wallet 2
 *   sends card 2 to wallet 1;
 * - the admin changes card 1's token URI (setTokenURI, no event, as on
 *   Manifold), which NFT history records as an edit;
 * - card 4 by a Manifold claim (SeedClaim.sol at the lazy claim
 *   extension's address): the admin initializes claim 7 for it, and wallet
 *   2 mints one for the claim's cost; NFT history records the claim;
 * - Meme Lab card 1 made for wallet 1, and wallet 2's paid mint of it;
 * - NextGen collection 1 (SeedNextGen.sol at the NextGen core and minter
 *   addresses): created, its data and phases set, one token minted to
 *   wallet 1 in the public phase and sent on to wallet 2;
 * - enough empty blocks after them that the finalized block covers them,
 *   two hours apart, so that they cross the day boundaries TDH's days
 *   need.
 *
 * The tokens' metadata files go into the run's seed files directory, which
 * the files source serves (seed-metadata.ts).
 */

/** A fake address: `n` in the last bytes, zeros before. */
const fixtureAddress = (n: number) => zeroPadValue(toBeHex(n), 20);

/** The probe fixture's wallets, which the probes ask about. */
export const SEED_WALLET_1 = PROBE_WALLETS[0];
export const SEED_WALLET_2 = PROBE_WALLETS[1];
/** The creator contracts' and NextGen's admin. */
export const SEED_ADMIN = fixtureAddress(0x0a);
/** Memes mint price for the paid mints, in ETH. */
export const SEED_MINT_PRICE = '0.06529';
export const SEED_LAB_MINT_PRICE = '0.01';
// anvil's finalized block trails the head by 64.
const BLOCKS_AFTER = 70;
// 140 hours: every run crosses at least two midnights more than a day
// after the seed's mints (TDH counts a card from the day after its mint),
// so TDH has two days, the newest one and the one before it for history.
const SECONDS_BETWEEN_BLOCKS_AFTER = 7200;
const RECEIPT_WAIT_MS = 60_000;
const NEXTGEN_CORE = NEXTGEN_CORE_CONTRACT[Network.ETH_MAINNET];
const NEXTGEN_MINTER = NEXTGEN_MINTER_CONTRACT[Network.ETH_MAINNET];
export const SEED_NEXTGEN_TOKEN = 10_000_000_000;
export const SEED_NEXTGEN_MINT_PRICE = '0.0069';

export const SEED_CREATOR = new Interface([
  'function mintBaseNew(address[] to,uint256[] amounts,string[] newUris) returns (uint256[])',
  'function mintExisting(uint256 id,uint256 amount) payable',
  'function setTokenURI(uint256 tokenId,string uri_)',
  'function safeTransferFrom(address from,address to,uint256 id,uint256 amount,bytes data)',
  'function uri(uint256 id) view returns (string)',
  'function tokenURI(uint256 id) view returns (string)',
  'function balanceOf(uint256,address) view returns (uint256)'
]);

/** The claim extension's functions the seed calls, with the real signatures. */
export const SEED_CLAIM = new Interface([
  'function initializeClaim(address creatorContractAddress,uint256 instanceId,(uint32 totalMax,uint32 walletMax,uint48 startDate,uint48 endDate,uint8 storageProtocol,bytes32 merkleRoot,string location,uint256 cost,address paymentReceiver,address erc20,address signingAddress) claimParameters)',
  'function mint(address creatorContractAddress,uint256 claimIndex,uint32 mintIndex,bytes32[] merkleProof,address mintFor) payable',
  'function getClaim(address,uint256) view returns ((uint32 total,uint32 totalMax,uint32 walletMax,uint48 startDate,uint48 endDate,uint8 storageProtocol,bytes32 merkleRoot,string location,uint256 tokenId,uint256 cost,address paymentReceiver,address erc20,address signingAddress))',
  'function getClaimForToken(address creatorContractAddress,uint256 tokenId) view returns (uint256 instanceId,(uint32 total,uint32 totalMax,uint32 walletMax,uint48 startDate,uint48 endDate,uint8 storageProtocol,bytes32 merkleRoot,string location,uint256 tokenId,uint256 cost,address paymentReceiver,address erc20,address signingAddress) claim)'
]);
export const SEED_CLAIM_INSTANCE = 7;
/**
 * Where the claim's mint price goes. Not the admin: 0x…0a is a precompile
 * (point evaluation), which fails a plain value transfer.
 */
export const SEED_PAYMENT_RECEIVER = fixtureAddress(0xfe);

function claimTransactions(): SeedTransaction[] {
  return [
    {
      from: SEED_ADMIN,
      to: MANIFOLD_LAZY_CLAIM_CONTRACT,
      data: SEED_CLAIM.encodeFunctionData('initializeClaim', [
        MEMES_CONTRACT,
        SEED_CLAIM_INSTANCE,
        {
          totalMax: 100,
          walletMax: 0,
          startDate: 0,
          endDate: 0,
          // Arweave: the location is the metadata file's id.
          storageProtocol: 2,
          merkleRoot: `0x${'00'.repeat(32)}`,
          location: SEED_FILES.memesClaimCard.id,
          cost: parseEther(SEED_MINT_PRICE),
          paymentReceiver: SEED_PAYMENT_RECEIVER,
          erc20: NULL_ADDRESS,
          signingAddress: NULL_ADDRESS
        }
      ])
    },
    {
      from: SEED_WALLET_2,
      to: MANIFOLD_LAZY_CLAIM_CONTRACT,
      data: SEED_CLAIM.encodeFunctionData('mint', [
        MEMES_CONTRACT,
        SEED_CLAIM_INSTANCE,
        0,
        [],
        SEED_WALLET_2
      ]),
      value: toBeHex(parseEther(SEED_MINT_PRICE))
    }
  ];
}

/** The NextGen functions the seed calls, as the real contracts declare them. */
export const SEED_NEXTGEN = new Interface([
  'function createCollection(string _collectionName,string _collectionArtist,string _collectionDescription,string _collectionWebsite,string _collectionLicense,string _collectionBaseURI,string _collectionLibrary,bytes32 _collectionDependencyScript,string[] _collectionScript)',
  'function setCollectionData(uint256 _collectionID,address _collectionArtistAddress,uint256 _maxCollectionPurchases,uint256 _collectionTotalSupply,uint256 _setFinalSupplyTimeAfterMint)',
  'function safeTransferFrom(address from,address to,uint256 tokenId)',
  'function tokenData(uint256) view returns (string)',
  'function setCollectionPhases(uint256 _collectionID,uint256 _allowlistStartTime,uint256 _allowlistEndTime,uint256 _publicStartTime,uint256 _publicEndTime,bytes32 _merkleRoot)',
  'function mint(uint256 _collectionID,uint256 _numberOfTokens,uint256 _maxAllowance,string _tokenData,address _mintTo,bytes32[] merkleProof,address _delegator,uint256 _saltfun_o) payable'
]);

function nextGenTransactions(): SeedTransaction[] {
  const zero = `0x${'00'.repeat(32)}`;
  // The files source serves the token's file for any path under its id.
  const baseUri = `${seedTokenUri(SEED_FILES.nextGenToken)}/`;
  return [
    {
      from: SEED_ADMIN,
      to: NEXTGEN_CORE,
      data: SEED_NEXTGEN.encodeFunctionData('createCollection', [
        'Seed Pebbles',
        SEED_ARTIST,
        "The rebuild check's NextGen collection.",
        'https://example.com/seed-pebbles',
        'CC0',
        baseUri,
        '',
        zero,
        ['// the generative script']
      ])
    },
    {
      from: SEED_ADMIN,
      to: NEXTGEN_CORE,
      data: SEED_NEXTGEN.encodeFunctionData('setCollectionData', [
        1,
        SEED_ADMIN,
        2,
        100,
        0
      ])
    },
    {
      from: SEED_ADMIN,
      to: NEXTGEN_MINTER,
      // A public phase over 2026.
      data: SEED_NEXTGEN.encodeFunctionData('setCollectionPhases', [
        1,
        0,
        0,
        1767225600,
        1798761600,
        zero
      ])
    },
    {
      from: SEED_WALLET_1,
      to: NEXTGEN_MINTER,
      data: SEED_NEXTGEN.encodeFunctionData('mint', [
        1,
        1,
        0,
        '{"Phase":"Public"}',
        SEED_WALLET_1,
        [],
        NULL_ADDRESS,
        0
      ]),
      value: toBeHex(parseEther(SEED_NEXTGEN_MINT_PRICE))
    },
    {
      from: SEED_WALLET_1,
      to: NEXTGEN_CORE,
      data: SEED_NEXTGEN.encodeFunctionData('safeTransferFrom', [
        SEED_WALLET_1,
        SEED_WALLET_2,
        SEED_NEXTGEN_TOKEN
      ])
    }
  ];
}

interface SeedTransaction {
  readonly from: string;
  readonly to: string;
  readonly data: string;
  readonly value?: string;
}

/** The seed's transactions, in order. */
export function seedTransactions(): SeedTransaction[] {
  const [card1, card2, card3] = SEED_FILES.memes.map(seedTokenUri);
  const [labCard1] = SEED_FILES.memeLab.map(seedTokenUri);
  const make = (to: string, wallet: string, uri: string) => ({
    from: SEED_ADMIN,
    to,
    data: SEED_CREATOR.encodeFunctionData('mintBaseNew', [[wallet], [1], [uri]])
  });
  const paid = (to: string, wallet: string, id: number, price: string) => ({
    from: wallet,
    to,
    data: SEED_CREATOR.encodeFunctionData('mintExisting', [id, 1]),
    value: toBeHex(parseEther(price))
  });
  const send = (from: string, to: string, id: number) => ({
    from,
    to: MEMES_CONTRACT,
    data: SEED_CREATOR.encodeFunctionData('safeTransferFrom', [
      from,
      to,
      id,
      1,
      '0x'
    ])
  });
  return [
    make(MEMES_CONTRACT, SEED_WALLET_1, card1),
    make(MEMES_CONTRACT, SEED_WALLET_2, card2),
    make(MEMES_CONTRACT, SEED_WALLET_1, card3),
    paid(MEMES_CONTRACT, SEED_WALLET_2, 1, SEED_MINT_PRICE),
    paid(MEMES_CONTRACT, SEED_WALLET_1, 2, SEED_MINT_PRICE),
    send(SEED_WALLET_1, SEED_WALLET_2, 3),
    send(SEED_WALLET_2, SEED_WALLET_1, 2),
    {
      from: SEED_ADMIN,
      to: MEMES_CONTRACT,
      data: SEED_CREATOR.encodeFunctionData('setTokenURI', [
        1,
        seedTokenUri(SEED_FILES.memesCard1Changed)
      ])
    },
    ...claimTransactions(),
    make(MEMELAB_CONTRACT, SEED_WALLET_1, labCard1),
    paid(MEMELAB_CONTRACT, SEED_WALLET_2, 1, SEED_LAB_MINT_PRICE),
    ...nextGenTransactions()
  ];
}

async function rpc<T>(url: string, method: string, params: unknown[]) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  const answer = (await response.json()) as {
    result?: T;
    error?: { message: string };
  };
  if (answer.error) throw new Error(`${method}: ${answer.error.message}`);
  return answer.result as T;
}

/**
 * The transaction's receipt once anvil has mined it. Anvil can answer the
 * send before the block holding it is sealed, so an immediate receipt
 * request may still get null.
 */
async function minedReceipt(
  url: string,
  hash: string
): Promise<{ status: string }> {
  const deadline = Date.now() + RECEIPT_WAIT_MS;
  for (;;) {
    const receipt = await rpc<{ status: string } | null>(
      url,
      'eth_getTransactionReceipt',
      [hash]
    );
    if (receipt) return receipt;
    if (Date.now() > deadline)
      throw new Error(`Seed transaction ${hash} was not mined`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Writes the seed's world on the local Ethereum; false if it is there. */
export async function writeSeedChain(url: string): Promise<boolean> {
  const code = await rpc<string>(url, 'eth_getCode', [
    MEMES_CONTRACT,
    'latest'
  ]);
  if (code !== '0x') {
    logger.info('[CHAIN ALREADY SEEDED]');
    return false;
  }
  for (const contract of [
    MEMES_CONTRACT,
    MEMELAB_CONTRACT,
    GRADIENT_CONTRACT
  ]) {
    await rpc(url, 'anvil_setCode', [contract, SEED_CREATOR_RUNTIME]);
  }
  await rpc(url, 'anvil_setCode', [
    MANIFOLD_LAZY_CLAIM_CONTRACT,
    SEED_CLAIM_RUNTIME
  ]);
  await rpc(url, 'anvil_setCode', [NEXTGEN_CORE, SEED_NEXTGEN_CORE_RUNTIME]);
  await rpc(url, 'anvil_setCode', [
    NEXTGEN_MINTER,
    SEED_NEXTGEN_MINTER_RUNTIME
  ]);
  // Each NextGen contract's slot 0 holds the other's address.
  await rpc(url, 'anvil_setStorageAt', [
    NEXTGEN_CORE,
    toBeHex(0),
    zeroPadValue(NEXTGEN_MINTER, 32)
  ]);
  await rpc(url, 'anvil_setStorageAt', [
    NEXTGEN_MINTER,
    toBeHex(0),
    zeroPadValue(NEXTGEN_CORE, 32)
  ]);
  for (const account of [SEED_ADMIN, SEED_WALLET_1, SEED_WALLET_2]) {
    await rpc(url, 'anvil_impersonateAccount', [account]);
    await rpc(url, 'anvil_setBalance', [account, toBeHex(parseEther('10'))]);
  }
  for (const transaction of seedTransactions()) {
    const hash = await rpc<string>(url, 'eth_sendTransaction', [
      { ...transaction, gas: toBeHex(500_000) }
    ]);
    const receipt = await minedReceipt(url, hash);
    if (receipt.status !== '0x1')
      throw new Error(`Seed transaction ${hash} reverted`);
  }
  for (const account of [SEED_ADMIN, SEED_WALLET_1, SEED_WALLET_2]) {
    await rpc(url, 'anvil_stopImpersonatingAccount', [account]);
  }
  await rpc(url, 'anvil_mine', [
    toBeHex(BLOCKS_AFTER),
    toBeHex(SECONDS_BETWEEN_BLOCKS_AFTER)
  ]);
  logger.info(`[CHAIN SEEDED] [${seedTransactions().length} TRANSACTIONS]`);
  return true;
}

/**
 * The rebuild check's seed step: the metadata files and the world on
 * anvil, then the tables.
 */
export async function seedHoldings(ctx: RebuildContext): Promise<void> {
  const url = ctx.sources.ethereum;
  if (!url) throw new Error('The holdings seed needs the ethereum source');
  if (!ctx.seedFilesDir)
    throw new Error('The holdings seed needs the files source');
  writeSeedFiles(ctx.seedFilesDir);
  await writeSeedChain(url);
  await rebuildHoldings(ctx);
  await rebuildWalletTransferAnalysis();
}

/**
 * Every holdings rebuild step, in order, as one: the steps hand wallets to
 * each other through transfer_reconciliations, and the Memes and NextGen
 * steps both write `transactions`, so one step writes them.
 *
 * NextGen runs before the owners, which count its tokens, and again after
 * the balances: its run refreshes the collections' hold rates and the
 * trait scores, which read the NFT catalogue, as the live loop does once
 * the catalogue is there.
 */
export async function rebuildHoldings(ctx: {
  readonly mark: { readonly ethBlock: number | null };
}): Promise<void> {
  await rebuildTransactions(ctx);
  await rebuildNextGen(ctx);
  await rebuildNftOwners();
  await rebuildNftCatalogue();
  await rebuildNftHistoryStep(ctx);
  await rebuildHoldingsBalances();
  await rebuildNextGen(ctx);
  // Empty until the team's export; the step refuses an empty file.
  if (readMemeLabRoyalties().length) await rebuildMemeLabRoyalties();
  else logger.info('[MEME LAB ROYALTIES FILE EMPTY] [NOT WRITTEN]');
}
