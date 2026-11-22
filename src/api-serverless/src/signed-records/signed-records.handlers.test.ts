import { BadRequestException } from '@/exceptions';
import { recordAnchorService } from '@/signed-records/record-anchor';
import { recordOwnerDirectory } from '@/signed-records/record-owner-directory';
import { handleGetSignedRecordsOwners } from './signed-records.handlers';

const BOUND = `0x${'a'.repeat(40)}`;
const UNBOUND = `0x${'b'.repeat(40)}`;
const PRINCIPAL = `0x${'0'.repeat(63)}1`;

const request = (wallets?: string) =>
  ({ query: wallets === undefined ? {} : { wallets } }) as Parameters<
    typeof handleGetSignedRecordsOwners
  >[0];

describe('GET /signed-records/owners', () => {
  beforeEach(() => {
    jest.spyOn(recordAnchorService, 'getAnchor').mockResolvedValue({
      anchor: 900,
      headHeight: 902,
      finalizedTime: 1_795_000_000_000,
      maxAnchorLag: 120
    });
    jest
      .spyOn(recordOwnerDirectory, 'ownerAt')
      .mockImplementation(async (wallet) =>
        wallet === BOUND ? PRINCIPAL : wallet
      );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('names each wallet once, lowercase, by its owner at the latest finalized height', async () => {
    await expect(
      handleGetSignedRecordsOwners(
        request(
          `${BOUND.toUpperCase().replace('0X', '0x')}, ${UNBOUND},${BOUND}`
        )
      )
    ).resolves.toEqual({
      anchor: 900,
      owners: [
        { wallet: BOUND, owner: PRINCIPAL },
        { wallet: UNBOUND, owner: UNBOUND }
      ]
    });
    expect(recordOwnerDirectory.ownerAt).toHaveBeenCalledWith(BOUND, 900);
  });

  it('takes 1 to 50 wallets, each an address', async () => {
    await expect(handleGetSignedRecordsOwners(request())).rejects.toThrow(
      BadRequestException
    );
    await expect(
      handleGetSignedRecordsOwners(request('not-a-wallet'))
    ).rejects.toThrow('Send 1 to 50 wallets');
    const many = Array.from(
      { length: 51 },
      (_, index) => `0x${index.toString(16).padStart(40, '0')}`
    ).join(',');
    await expect(handleGetSignedRecordsOwners(request(many))).rejects.toThrow(
      'Send 1 to 50 wallets'
    );
  });
});
