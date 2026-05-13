import { getTdhForAddress } from '@/db-api';
import { validateTDH } from './rememes_validation';

jest.mock('@/db-api', () => ({
  getTdhForAddress: jest.fn(),
  rememeExists: jest.fn()
}));

jest.mock('@/api/seize-settings', () => ({
  seizeSettings: () => ({
    rememes_submission_tdh_threshold: 100
  })
}));

const getTdhForAddressMock = getTdhForAddress as jest.MockedFunction<
  typeof getTdhForAddress
>;

describe('validateTDH', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('validates TDH when contract deployer metadata is missing', async () => {
    getTdhForAddressMock.mockResolvedValue(101);

    await expect(validateTDH('0xabc')).resolves.toBe(true);

    expect(getTdhForAddressMock).toHaveBeenCalledWith('0xabc');
  });

  it('allows the contract deployer without checking TDH', async () => {
    await expect(validateTDH('0xabc', '0xABC')).resolves.toBe(true);

    expect(getTdhForAddressMock).not.toHaveBeenCalled();
  });

  it('rejects addresses below the TDH threshold', async () => {
    getTdhForAddressMock.mockResolvedValue(99);

    await expect(validateTDH('0xabc')).resolves.toBe(false);
  });
});
