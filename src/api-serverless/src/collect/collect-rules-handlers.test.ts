import * as Operations from '@/api/generated/routes/operations';
import {
  handleCreateCollectRule,
  handlePauseCollectRule,
  handlePrepareCollectRule,
  handleReconcileCollectRule
} from '@/api/collect/collect-rules.handlers';
import {
  createRule,
  prepareRule,
  reconcileRule
} from '@/api/collect/collect-rules.service';

let mockFrozen = false;

jest.mock('@/api/marketplace/marketplace.http', () => ({
  executeMarketRequest: (
    _req: unknown,
    work: (auth: unknown) => Promise<unknown>
  ) => work({})
}));
jest.mock('@/api/marketplace/marketplace.service', () => ({
  assertMarketActor: () => ({ profileId: 'profile-1', wallet: '0x01' })
}));
jest.mock('@/personal-records/personal-records-state.db', () => ({
  personalRecordsStateDb: {
    read: async () => ({ frozen: mockFrozen, importOrder: null })
  }
}));
jest.mock('@/api/collect/collect-rules.service', () => ({
  createRule: jest.fn(),
  prepareRule: jest.fn(),
  reconcileRule: jest.fn(),
  requireRuleWallet: jest.fn()
}));

const RULE = '00000000-0000-4000-8000-0000000000c1';

async function refusalOf(
  request: Promise<unknown>
): Promise<{ status: number; code: string | undefined }> {
  try {
    await request;
  } catch (error) {
    const refused = error as { getStatusCode(): number; code?: string };
    return { status: refused.getStatusCode(), code: refused.code };
  }
  throw new Error('The request was not refused');
}

const create = () =>
  handleCreateCollectRule({
    body: {},
    get: () => RULE
  } as unknown as Operations.CreateCollectRuleRequest);
const pause = () =>
  handlePauseCollectRule({
    body: { expected_revision: 1, paused: true },
    params: { id: RULE }
  } as unknown as Operations.PauseCollectRuleRequest);
const prepare = () =>
  handlePrepareCollectRule({
    body: {},
    params: { id: RULE },
    get: () => RULE
  } as unknown as Operations.PrepareCollectRuleRequest);
const reconcile = () =>
  handleReconcileCollectRule({
    params: { id: RULE }
  } as unknown as Operations.ReconcileCollectRuleRequest);

describe('Collect rule routes and the personal records switch', () => {
  const saved = process.env.PERSONAL_RECORDS_MODE;
  beforeEach(() => {
    jest.clearAllMocks();
    mockFrozen = false;
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.PERSONAL_RECORDS_MODE;
    else process.env.PERSONAL_RECORDS_MODE = saved;
  });

  it('takes create and pause as signed records in primary mode', async () => {
    process.env.PERSONAL_RECORDS_MODE = 'primary';
    for (const request of [create(), pause()]) {
      expect(await refusalOf(request)).toEqual({
        status: 409,
        code: 'PERSONAL_RECORDS_REQUIRED'
      });
    }
    expect(createRule).not.toHaveBeenCalled();
  });

  it('pauses every rule change, prepare and reconcile too, while frozen', async () => {
    process.env.PERSONAL_RECORDS_MODE = 'legacy';
    mockFrozen = true;
    for (const request of [create(), pause(), prepare(), reconcile()]) {
      expect(await refusalOf(request)).toEqual({
        status: 503,
        code: 'PERSONAL_SETTINGS_PAUSED'
      });
    }
    expect(prepareRule).not.toHaveBeenCalled();
    expect(reconcileRule).not.toHaveBeenCalled();
  });

  it('keeps prepare and reconcile open in primary mode', async () => {
    process.env.PERSONAL_RECORDS_MODE = 'primary';
    jest.mocked(reconcileRule).mockResolvedValue({
      state: 'ACTIVE',
      mode: 'prepare_for_approval'
    } as never);
    await expect(reconcile()).resolves.toMatchObject({ state: 'ACTIVE' });
    expect(reconcileRule).toHaveBeenCalledWith(RULE, {});
  });
});
