import { WaveHubCreationService } from './wave-hub-creation.service';
import { ApiCreateWaveHubRequest } from '@/api/generated/models/ApiCreateWaveHubRequest';
import { AuthenticationContext } from '@/auth-context';
import { RequestContext, getRequestScopedPromise } from '@/request.context';

const mockPrepare = jest.fn();
const mockCreate = jest.fn();
const mockGetHub = jest.fn();
const mockFindSaved = jest.fn();
const mockCommand = jest.fn();

jest.mock('@/api/waves/wave.api.service', () => ({
  waveApiService: {
    prepareWaveCreation: (...args: unknown[]) => mockPrepare(...args),
    createWave: (...args: unknown[]) => mockCreate(...args)
  }
}));
jest.mock('@/competitions/competition.service', () => ({
  competitionService: { getHub: (...args: unknown[]) => mockGetHub(...args) }
}));
jest.mock('@/competitions/competition-command.repository', () => ({
  competitionCommandRepository: {
    findSavedCommand: (...args: unknown[]) => mockFindSaved(...args),
    command: (...args: unknown[]) => mockCommand(...args)
  }
}));
jest.mock('@/app-features', () => ({
  appFeatures: { isNativeCompetitionHubCreationEnabled: () => true }
}));

describe('Native private hub creation', () => {
  const request = {
    idempotency_key: 'create-private-hub',
    name: 'Private hub',
    visibility: { scope: { group_id: 'new-private-group' } },
    chat: { enabled: true, scope: { group_id: 'new-private-group' } },
    admin_group: { group_id: null }
  } as ApiCreateWaveHubRequest;
  const hub = { id: 'private-hub', name: 'Private hub' };
  let ctx: RequestContext;
  let committed: boolean;
  let refreshed: boolean;

  beforeEach(async () => {
    jest.clearAllMocks();
    committed = false;
    refreshed = false;
    ctx = {
      authenticationContext: new AuthenticationContext({
        authenticatedWallet: '0x1111111111111111111111111111111111111111',
        authenticatedProfileId: 'creator',
        roleProfileId: null,
        activeProxyActions: []
      })
    };
    await getRequestScopedPromise(ctx, 'old-eligibility', async () => []);
    mockFindSaved.mockResolvedValue(null);
    mockPrepare.mockResolvedValue({ id: hub.id });
    mockCreate.mockImplementation(
      async (_request, _isDm, _tx, effects: Array<() => Promise<void>>) => {
        effects.push(async () => {
          expect(committed).toBe(true);
          refreshed = true;
        });
        return hub;
      }
    );
    mockCommand.mockImplementation(async (_actor, _key, _payload, execute) => {
      const receipt = await execute({ ...ctx, connection: {} });
      committed = true;
      return receipt;
    });
    mockGetHub.mockImplementation(async (_id, readCtx: RequestContext) => {
      if (!committed || !refreshed) throw new Error('Wave not found');
      expect(readCtx.connection).toBeUndefined();
      expect(readCtx.requestScope).toBeUndefined();
      return hub;
    });
  });

  it('reads private access only after commit and group invalidation, with a fresh request scope', async () => {
    await expect(
      new WaveHubCreationService().create(request, ctx)
    ).resolves.toEqual(hub);
    expect(mockGetHub).toHaveBeenCalledTimes(1);
  });

  it('retries the committed receipt without creating another wave', async () => {
    mockFindSaved.mockResolvedValue({ id: hub.id });
    mockGetHub.mockResolvedValue(hub);
    await expect(
      new WaveHubCreationService().create(request, ctx)
    ).resolves.toEqual(hub);
    expect(mockPrepare).not.toHaveBeenCalled();
    expect(mockCommand).not.toHaveBeenCalled();
    expect(mockGetHub).toHaveBeenCalledWith(hub.id, ctx);
  });

  it('keeps the committed receipt retryable if the final read fails', async () => {
    mockGetHub.mockRejectedValueOnce(new Error('Read temporarily unavailable'));
    const service = new WaveHubCreationService();
    await expect(service.create(request, ctx)).rejects.toThrow(
      'Read temporarily unavailable'
    );
    expect(committed).toBe(true);
    expect(refreshed).toBe(true);
    mockFindSaved.mockResolvedValue({ id: hub.id });
    mockGetHub.mockResolvedValue(hub);
    await expect(service.create(request, ctx)).resolves.toEqual(hub);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});
