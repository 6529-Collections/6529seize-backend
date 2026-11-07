import { assertTelemetryTeamReader } from '@/api/telemetry/telemetry-team-auth';
import { ForbiddenException } from '@/exceptions';

const mockFindWaveById = jest.fn();
const mockEligibleByIds = jest.fn();
const mockAuthContext = jest.fn();

jest.mock('@/api/waves/waves.api.db', () => ({
  wavesApiDb: {
    findWaveById: (...args: unknown[]) => mockFindWaveById(...args)
  }
}));

jest.mock('@/api/community-members/user-groups.service', () => ({
  userGroupsService: {
    getGroupsUserIsEligibleForByIds: (...args: unknown[]) =>
      mockEligibleByIds(...args)
  }
}));

jest.mock('@/api/auth/auth', () => ({
  getAuthenticationContext: (...args: unknown[]) => mockAuthContext(...args)
}));

const READER_WAVE_ID = '49f0e595-ec7c-4235-8695-a527f61b69f4';
const CHAT_GROUP_ID = 'dev-team-chat-group';
const MEMBER = 'profile-member';

function context(profileId: string | null, proxy = false) {
  return {
    authenticatedProfileId: profileId,
    isAuthenticatedAsProxy: () => proxy
  };
}

const req = {} as any;

describe('assertTelemetryTeamReader (Follow The Repo writers)', () => {
  beforeEach(() => {
    process.env.TELEMETRY_DIAG_READER_WAVE_ID = READER_WAVE_ID;
    mockFindWaveById.mockReset().mockResolvedValue({
      id: READER_WAVE_ID,
      chat_enabled: true,
      chat_group_id: CHAT_GROUP_ID
    });
    mockEligibleByIds.mockReset().mockResolvedValue([CHAT_GROUP_ID]);
    mockAuthContext.mockReset().mockResolvedValue(context(MEMBER));
  });

  afterAll(() => {
    delete process.env.TELEMETRY_DIAG_READER_WAVE_ID;
  });

  it('allows a current member of the wave chat group', async () => {
    await expect(assertTelemetryTeamReader(req)).resolves.toBe(MEMBER);
    expect(mockFindWaveById).toHaveBeenCalledWith(READER_WAVE_ID);
    expect(mockEligibleByIds).toHaveBeenCalledWith(MEMBER, [CHAT_GROUP_ID]);
  });

  it('refuses a non-member with 403', async () => {
    mockAuthContext.mockResolvedValue(context('profile-outsider'));
    mockEligibleByIds.mockResolvedValue([]);
    await expect(assertTelemetryTeamReader(req)).rejects.toBeInstanceOf(
      ForbiddenException
    );
  });

  it('denies a removed member on the very next request', async () => {
    await expect(assertTelemetryTeamReader(req)).resolves.toBe(MEMBER);
    mockEligibleByIds.mockResolvedValue([]);
    await expect(assertTelemetryTeamReader(req)).rejects.toBeInstanceOf(
      ForbiddenException
    );
    expect(mockEligibleByIds).toHaveBeenCalledTimes(2);
  });

  it('denies everyone when the reader wave is unset', async () => {
    for (const value of [undefined, '', '   ']) {
      if (value === undefined) {
        delete process.env.TELEMETRY_DIAG_READER_WAVE_ID;
      } else {
        process.env.TELEMETRY_DIAG_READER_WAVE_ID = value;
      }
      await expect(assertTelemetryTeamReader(req)).rejects.toBeInstanceOf(
        ForbiddenException
      );
    }
    expect(mockEligibleByIds).not.toHaveBeenCalled();
  });

  it('denies everyone when the wave cannot be resolved or its chat is not group-restricted', async () => {
    for (const wave of [
      null,
      { chat_enabled: false, chat_group_id: CHAT_GROUP_ID },
      { chat_enabled: true, chat_group_id: null }
    ]) {
      mockFindWaveById.mockResolvedValue(wave);
      await expect(assertTelemetryTeamReader(req)).rejects.toBeInstanceOf(
        ForbiddenException
      );
    }
    expect(mockEligibleByIds).not.toHaveBeenCalled();
  });

  it('denies anonymous callers and proxies', async () => {
    mockAuthContext.mockResolvedValue(context(null));
    await expect(assertTelemetryTeamReader(req)).rejects.toBeInstanceOf(
      ForbiddenException
    );
    mockAuthContext.mockResolvedValue(context(MEMBER, true));
    await expect(assertTelemetryTeamReader(req)).rejects.toBeInstanceOf(
      ForbiddenException
    );
  });
});
