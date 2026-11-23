import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MEMELAB_CONTRACT, MEMES_CONTRACT } from '@/constants';
import { parseDecentralizedMediaRef } from '@/decentralized-media/decentralized-media';
import {
  NEXTGEN_CORE_CONTRACT,
  NEXTGEN_MINTER_CONTRACT
} from '@/nextgen/nextgen_constants';
import { NEXTGEN_CORE_IFACE, NEXTGEN_MINTER_IFACE } from '@/abis/nextgen';
import { Network } from '@/ethereum-rpc/ethereum-rpc-network';
import { MANIFOLD_LAZY_CLAIM_CONTRACT } from '@/constants/manifold';
import { NFT_HISTORY_IFACE } from '@/abis/nft_history';
import { checkFiles, FILE_INDEX } from '@/rebuild/sources/file-server';
import { SEED_CLAIM_RUNTIME } from './seed-claim.runtime';
import {
  SEED_ADMIN,
  SEED_CLAIM,
  SEED_CLAIM_INSTANCE,
  SEED_CREATOR,
  SEED_NEXTGEN,
  SEED_NEXTGEN_TOKEN,
  SEED_WALLET_1,
  SEED_WALLET_2,
  seedTransactions
} from './holdings-seed';
import { SEED_CREATOR_RUNTIME } from './seed-creator.runtime';
import {
  SEED_NEXTGEN_CORE_RUNTIME,
  SEED_NEXTGEN_MINTER_RUNTIME
} from './seed-nextgen.runtime';
import {
  SEED_FILES,
  seedFiles,
  seedTokenUri,
  writeSeedFiles
} from './seed-metadata';

describe('the holdings seed', () => {
  it("writes its files where the files source serves them, beside other seeds' files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'holdings-seed-'));
    try {
      const other = 'another-seeds-file';
      fs.writeFileSync(path.join(dir, other), 'x');
      fs.writeFileSync(
        path.join(dir, FILE_INDEX),
        JSON.stringify({
          [other]:
            '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881'
        })
      );
      writeSeedFiles(dir);
      const { files, problems } = checkFiles(dir);
      expect(problems).toEqual([]);
      expect(Array.from(files.keys()).sort()).toEqual(
        [other, ...seedFiles().map((file) => file.id)].sort()
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('names each file by an Arweave-shaped id the media code recognizes', () => {
    for (const file of seedFiles()) {
      expect(parseDecentralizedMediaRef(seedTokenUri(file))).toEqual({
        protocol: 'arweave',
        id: file.id,
        path: ''
      });
    }
  });

  it('installs code that answers every function the seed and loops call', () => {
    const selectors: string[] = [];
    SEED_CREATOR.forEachFunction((fn) => selectors.push(fn.selector.slice(2)));
    expect(selectors).toHaveLength(7);
    for (const selector of selectors) {
      expect(SEED_CREATOR_RUNTIME).toContain(selector);
    }
  });

  it('makes cards 1 to 3 of the Memes and card 1 of the Meme Lab, then mints, sends, changes a URI and pays', () => {
    const calls = seedTransactions()
      .filter((t) => t.to === MEMES_CONTRACT || t.to === MEMELAB_CONTRACT)
      .map((t) => {
        const parsed = SEED_CREATOR.parseTransaction({
          data: t.data,
          value: t.value ?? 0
        })!;
        return [
          t.to === MEMES_CONTRACT
            ? 'memes'
            : t.to === MEMELAB_CONTRACT
              ? 'lab'
              : t.to,
          t.from,
          parsed.name,
          ...parsed.args.map((a) =>
            Array.isArray(a) ? [...a].map(String) : String(a)
          ),
          t.value ? 'paid' : 'free'
        ];
      });
    const [card1, card2, card3] = SEED_FILES.memes.map(seedTokenUri);
    const [lab1] = SEED_FILES.memeLab.map(seedTokenUri);
    const admin = SEED_ADMIN;
    expect(calls).toEqual([
      ['memes', admin, 'mintBaseNew', [SEED_WALLET_1], ['1'], [card1], 'free'],
      ['memes', admin, 'mintBaseNew', [SEED_WALLET_2], ['1'], [card2], 'free'],
      ['memes', admin, 'mintBaseNew', [SEED_WALLET_1], ['1'], [card3], 'free'],
      ['memes', SEED_WALLET_2, 'mintExisting', '1', '1', 'paid'],
      ['memes', SEED_WALLET_1, 'mintExisting', '2', '1', 'paid'],
      [
        'memes',
        SEED_WALLET_1,
        'safeTransferFrom',
        SEED_WALLET_1,
        SEED_WALLET_2,
        '3',
        '1',
        '0x',
        'free'
      ],
      [
        'memes',
        SEED_WALLET_2,
        'safeTransferFrom',
        SEED_WALLET_2,
        SEED_WALLET_1,
        '2',
        '1',
        '0x',
        'free'
      ],
      [
        'memes',
        admin,
        'setTokenURI',
        '1',
        seedTokenUri(SEED_FILES.memesCard1Changed),
        'free'
      ],
      ['lab', admin, 'mintBaseNew', [SEED_WALLET_1], ['1'], [lab1], 'free'],
      ['lab', SEED_WALLET_2, 'mintExisting', '1', '1', 'paid']
    ]);
  });

  it('calls the NextGen contracts with their real ABI, which the loop decodes them with', () => {
    const core = NEXTGEN_CORE_CONTRACT[Network.ETH_MAINNET];
    const minter = NEXTGEN_MINTER_CONTRACT[Network.ETH_MAINNET];
    const calls = seedTransactions()
      .filter((t) => t.to === core || t.to === minter)
      .map((t) => {
        const iface = t.to === core ? NEXTGEN_CORE_IFACE : NEXTGEN_MINTER_IFACE;
        const parsed = iface.parseTransaction({ data: t.data })!;
        return `${t.to === core ? 'core' : 'minter'}.${parsed.name}`;
      });
    expect(calls).toEqual([
      'core.createCollection',
      'core.setCollectionData',
      'minter.setCollectionPhases',
      'minter.mint',
      'core.safeTransferFrom'
    ]);
    const transfer = seedTransactions().at(-1)!;
    expect(
      NEXTGEN_CORE_IFACE.parseTransaction({ data: transfer.data })!.args.tokenId
    ).toBe(BigInt(SEED_NEXTGEN_TOKEN));
  });

  it('installs NextGen code that answers every function the seed and the loop call', () => {
    const selectors = (names: string[]) =>
      names.map((name) => SEED_NEXTGEN.getFunction(name)!.selector.slice(2));
    for (const selector of selectors([
      'createCollection',
      'setCollectionData',
      'safeTransferFrom',
      'tokenData'
    ])) {
      expect(SEED_NEXTGEN_CORE_RUNTIME).toContain(selector);
    }
    for (const selector of selectors(['setCollectionPhases', 'mint'])) {
      expect(SEED_NEXTGEN_MINTER_RUNTIME).toContain(selector);
    }
  });

  it("installs NextGen code that holds no address; the seed sets each one's partner", () => {
    for (const address of [
      NEXTGEN_CORE_CONTRACT[Network.ETH_MAINNET],
      NEXTGEN_MINTER_CONTRACT[Network.ETH_MAINNET]
    ]) {
      const bare = address.slice(2).toLowerCase();
      expect(SEED_NEXTGEN_CORE_RUNTIME.toLowerCase()).not.toContain(bare);
      expect(SEED_NEXTGEN_MINTER_RUNTIME.toLowerCase()).not.toContain(bare);
    }
  });

  it('makes card 4 through a claim whose calldata NFT history decodes', () => {
    const calls = seedTransactions().filter(
      (t) => t.to === MANIFOLD_LAZY_CLAIM_CONTRACT
    );
    const parsed = calls.map(
      (t) =>
        NFT_HISTORY_IFACE.parseTransaction({
          data: t.data,
          value: t.value ?? 0
        })!
    );
    expect(parsed.map((p) => p.name)).toEqual(['initializeClaim', 'mint']);
    expect(String(parsed[0].args.creatorContractAddress)).toBe(MEMES_CONTRACT);
    expect(Number(parsed[0].args[1])).toBe(SEED_CLAIM_INSTANCE);
    expect(parsed[0].args.claimParameters.location).toBe(
      SEED_FILES.memesClaimCard.id
    );
    expect(Number(parsed[0].args.claimParameters.storageProtocol)).toBe(2);
    expect(calls[1].from).toBe(SEED_WALLET_2);
  });

  it('installs claim code that answers every function the seed and the loops call', () => {
    SEED_CLAIM.forEachFunction((fn) =>
      expect(SEED_CLAIM_RUNTIME).toContain(fn.selector.slice(2))
    );
  });
});
