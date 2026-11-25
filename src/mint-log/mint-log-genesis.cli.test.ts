jest.mock('@/secrets', () => ({
  doInDbContext: (run: () => Promise<unknown>) => run()
}));
jest.mock('@/sql-executor', () => ({
  ...jest.requireActual('@/sql-executor'),
  dbSupplier: () => ({
    executeNativeQueriesInTransaction: (run: (connection: object) => unknown) =>
      run({})
  })
}));

import { ipfsFileUploader } from '@/attachments/ipfs-file-uploader';
import { MEMES_CONTRACT } from '@/constants';
import { main } from './mint-log-genesis.cli';
import {
  encodeGenesisFile,
  MintGenesisFile,
  mintGenesisReader
} from './mint-log-genesis';
import { mintCard } from './mint-log-parts';
import {
  COLLAB_CARD_CONTRACT,
  MintCardRef,
  REMEMES_CARD_CONTRACT
} from './mint-log.types';

const MEMES = MEMES_CONTRACT.toLowerCase();
const CARDS: MintCardRef[] = [
  mintCard(MEMES, 1),
  mintCard(MEMES, 2),
  mintCard(
    REMEMES_CARD_CONTRACT,
    0,
    '0x0000000000000000000000000000000000000001'
  ),
  mintCard(COLLAB_CARD_CONTRACT, 0, 'drop-1')
];

/** A file whose size grows with the card id, so the largest is known. */
function fileOf(card: MintCardRef): MintGenesisFile {
  return {
    v: 1,
    card,
    state: {
      distribution: Array.from({ length: (card.card_id + 1) * 20 }, (_, i) => ({
        id: i,
        wallet: `0x${i.toString(16).padStart(40, '0')}`
      }))
    },
    normalized_pinned: []
  } as unknown as MintGenesisFile;
}

describe('mint-log:genesis dry run', () => {
  const fetchMock = jest.fn();
  let printed: string;

  beforeEach(() => {
    printed = '';
    process.env.IPFS_API_ENDPOINT = 'https://ipfs-api.example.test';
    global.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockReset();
    jest.spyOn(mintGenesisReader, 'cards').mockResolvedValue(CARDS);
    jest
      .spyOn(mintGenesisReader, 'file')
      .mockImplementation(async (card) => fileOf(card));
    jest.spyOn(ipfsFileUploader, 'uploadFile');
    jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      printed += String(chunk);
      return true;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.IPFS_API_ENDPOINT;
  });

  it('gives each chain its cards and file bytes, and uploads nothing', async () => {
    await main([]);

    const size = (card: MintCardRef) => encodeGenesisFile(fileOf(card)).length;
    expect(JSON.parse(printed)).toEqual({
      live: false,
      cards: { mint: 2, rememes: 1, collab: 1 },
      bytes: {
        mint: size(CARDS[0]) + size(CARDS[1]),
        rememes: size(CARDS[2]),
        collab: size(CARDS[3])
      },
      largest_file_bytes: {
        mint: size(CARDS[1]),
        rememes: size(CARDS[2]),
        collab: size(CARDS[3])
      }
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ipfsFileUploader.uploadFile).not.toHaveBeenCalled();
  });

  it('builds only the files of the chain it was given', async () => {
    await main(['--chain', 'rememes']);

    expect(JSON.parse(printed)).toMatchObject({
      cards: { rememes: 1 },
      bytes: { rememes: encodeGenesisFile(fileOf(CARDS[2])).length }
    });
    expect(mintGenesisReader.file).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ipfsFileUploader.uploadFile).not.toHaveBeenCalled();
  });
});
