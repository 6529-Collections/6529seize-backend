const mockSubmit = jest.fn();
const mockAuth = jest.fn();
const mockAnchor = jest.fn();
const mockOwnerAt = jest.fn();

jest.mock('@/api/auth/auth', () => ({
  getAuthenticationContext: (...args: unknown[]) => mockAuth(...args)
}));
jest.mock('@/personal-records/personal-records', () => ({
  personalRecordsService: {
    submit: (...args: unknown[]) => mockSubmit(...args)
  },
  personalProviderKeys: () => [
    { id: 'p1', publicKey: Buffer.from('11'.repeat(32), 'hex') }
  ]
}));
jest.mock('@/personal-records/personal-records-state.db', () => ({
  personalRecordsStateDb: {
    read: async () => ({ frozen: false, importOrder: null })
  }
}));
jest.mock('@/signed-records/record-anchor', () => ({
  recordAnchorService: { getAnchor: () => mockAnchor() }
}));
jest.mock('@/signed-records/record-owner-directory', () => ({
  recordOwnerDirectory: {
    ownerAt: (...args: unknown[]) => mockOwnerAt(...args)
  }
}));

import {
  handleGetSignedRecordsMode,
  handleSubmitSignedRecords
} from './signed-records.handlers';

const WALLET = '0x00000000000000000000000000000000000000c1';
const OWNER = `0x${'0'.repeat(63)}1`;

const auth = (opts: { profileId?: string | null; proxy?: boolean } = {}) => ({
  authenticatedWallet: WALLET,
  getActingAsId: () =>
    opts.profileId === undefined ? 'profile-1' : opts.profileId,
  isAuthenticatedAsProxy: () => opts.proxy === true
});

const submit = (body: unknown) => handleSubmitSignedRecords({ body } as never);

describe('POST /signed-records', () => {
  const saved = process.env.PERSONAL_RECORDS_MODE;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.PERSONAL_RECORDS_MODE = 'primary';
    mockAuth.mockResolvedValue(auth());
    mockSubmit.mockResolvedValue([{ id: '0x01', outcome: 'applied' }]);
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.PERSONAL_RECORDS_MODE;
    else process.env.PERSONAL_RECORDS_MODE = saved;
  });

  it('submits as the acting profile in the current mode', async () => {
    await expect(submit({ events: [{ id: '0x01' }] })).resolves.toEqual({
      mode: 'primary',
      results: [{ id: '0x01', outcome: 'applied' }]
    });
    expect(mockSubmit).toHaveBeenCalledWith(
      [{ id: '0x01' }],
      'primary',
      'profile-1',
      expect.objectContaining({ authenticationContext: expect.anything() })
    );
  });

  it('needs a profile, and refuses proxies', async () => {
    mockAuth.mockResolvedValue(auth({ profileId: null }));
    await expect(submit({ events: [{}] })).rejects.toThrow(
      'You need a profile'
    );
    mockAuth.mockResolvedValue(auth({ proxy: true }));
    await expect(submit({ events: [{}] })).rejects.toThrow(
      'Proxies cannot change settings'
    );
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it('takes only companions in shadow mode, and nothing in legacy', async () => {
    process.env.PERSONAL_RECORDS_MODE = 'shadow';
    await expect(submit({ events: [{}] })).rejects.toBeDefined();
    await expect(submit({ events: [{}], companion: true })).resolves.toEqual(
      expect.objectContaining({ mode: 'shadow' })
    );
    process.env.PERSONAL_RECORDS_MODE = 'legacy';
    await expect(
      submit({ events: [{}], companion: true })
    ).rejects.toBeDefined();
    expect(mockSubmit).toHaveBeenCalledTimes(1);
  });

  it('refuses an empty or oversized submit', async () => {
    await expect(submit({ events: [] })).rejects.toBeDefined();
    await expect(
      submit({ events: Array.from({ length: 17 }, () => ({})) })
    ).rejects.toBeDefined();
    expect(mockSubmit).not.toHaveBeenCalled();
  });
});

describe('GET /signed-records/mode', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.PERSONAL_RECORDS_MODE = 'primary';
    mockAuth.mockResolvedValue(auth());
  });

  it("answers the mode, the freeze, the caller's owner and the provider keys", async () => {
    mockAnchor.mockResolvedValue({ anchor: 1050 });
    mockOwnerAt.mockResolvedValue(OWNER);
    const mode = await handleGetSignedRecordsMode({} as never);
    expect(mode).toMatchObject({
      mode: 'primary',
      frozen: false,
      owner: OWNER,
      provider_keys: [{ id: 'p1', public_key: `0x${'11'.repeat(32)}` }]
    });
    expect(mockOwnerAt).toHaveBeenCalledWith(WALLET.toLowerCase(), 1050);
  });

  it('answers no owner while the gateway is away', async () => {
    mockAnchor.mockRejectedValue(new Error('no chain'));
    const mode = await handleGetSignedRecordsMode({} as never);
    expect(mode.owner).toBeNull();
    expect(mode.mode).toBe('primary');
  });
});
