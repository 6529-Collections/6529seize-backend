import { GetContentModerationBlockActivityRequest } from '@/api/generated/routes/operations';
import { contentModerationService } from '@/content-moderation/content-moderation.service';
import { BadRequestException, ForbiddenException } from '@/exceptions';
import { handleGetContentModerationBlockActivity } from './get-block-activity.handler';

const mockIsProxy = jest.fn(() => false);
const mockProfileId = jest.fn((): string | null => 'moderator-1');

jest.mock('@/api/auth/auth', () => ({
  getAuthenticationContext: jest.fn(async () => ({
    isAuthenticatedAsProxy: mockIsProxy,
    getActingAsId: mockProfileId
  }))
}));
jest.mock('@/content-moderation/content-moderation.service', () => ({
  contentModerationService: { getBlockActivity: jest.fn(async () => []) }
}));
jest.mock('@/time', () => ({ Timer: { getFromRequest: jest.fn() } }));

const request = (query: Record<string, string> = {}) =>
  ({ query }) as unknown as GetContentModerationBlockActivityRequest;

beforeEach(() => {
  jest.clearAllMocks();
  mockIsProxy.mockReturnValue(false);
  mockProfileId.mockReturnValue('moderator-1');
});

it.each([
  [{}, false],
  [{ include_unblocks: 'false' }, false],
  [{ include_unblocks: 'true' }, true]
] as const)(
  'validates the unblock opt-in %j',
  async (query, include_unblocks) => {
    await handleGetContentModerationBlockActivity(request(query));
    expect(contentModerationService.getBlockActivity).toHaveBeenCalledWith(
      'moderator-1',
      { limit: 50, include_unblocks },
      expect.any(Object)
    );
  }
);

it('rejects malformed unblock flags before accessing the feed', async () => {
  await expect(
    handleGetContentModerationBlockActivity(
      request({ include_unblocks: 'invalid' })
    )
  ).rejects.toBeInstanceOf(BadRequestException);
  expect(contentModerationService.getBlockActivity).not.toHaveBeenCalled();
});

it('does not expose either action type through a proxy', async () => {
  mockIsProxy.mockReturnValue(true);
  await expect(
    handleGetContentModerationBlockActivity(
      request({ include_unblocks: 'true' })
    )
  ).rejects.toBeInstanceOf(ForbiddenException);
  expect(contentModerationService.getBlockActivity).not.toHaveBeenCalled();
});

it('does not expose either action type without a profile', async () => {
  mockProfileId.mockReturnValue(null);
  await expect(
    handleGetContentModerationBlockActivity(
      request({ include_unblocks: 'true' })
    )
  ).rejects.toBeInstanceOf(ForbiddenException);
  expect(contentModerationService.getBlockActivity).not.toHaveBeenCalled();
});
