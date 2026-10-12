import {
  getMemeCollaborationState,
  respondToMemeCollaboration
} from './meme-collaborations.handlers';
import { dropsService } from '@/api/drops/drops.api.service';
import { memeCollaborationsService } from '@/meme-collaborations/meme-collaborations.service';
import type {
  GetMemeCollaborationStateRequest,
  RespondToMemeCollaborationRequest
} from '@/api/generated/routes/operations';
import { AuthenticationContext } from '@/auth-context';

jest.mock('@/api/auth/auth', () => ({
  getAuthenticationContext: jest.fn(async () =>
    AuthenticationContext.fromProfileId('B')
  )
}));
jest.mock('@/api/drops/drops.api.service', () => ({
  dropsService: { findDropByIdOrThrow: jest.fn() }
}));
jest.mock('@/meme-collaborations/meme-collaborations.service', () => ({
  memeCollaborationsService: { state: jest.fn(), respond: jest.fn() }
}));
jest.mock('@/api/ws/ws-listeners-notifier', () => ({
  wsListenersNotifier: { notifyAboutDropUpdate: jest.fn() }
}));
jest.mock('@/api/push-notifications/push-notifications.service', () => ({
  sendIdentityPushNotifications: jest.fn()
}));

const request = {
  params: { drop_id: 'drop', invitation_id: 'invitation' },
  body: {
    action: 'ACCEPT',
    artwork_hash: 'a'.repeat(64),
    terms_version: 'b'.repeat(64)
  }
} as unknown as RespondToMemeCollaborationRequest;
const getRequest = request as unknown as GetMemeCollaborationStateRequest;

describe('Collaboration API visibility', () => {
  beforeEach(() => jest.clearAllMocks());

  it('does not reveal stored artwork behind moderation', async () => {
    jest
      .mocked(dropsService.findDropByIdOrThrow)
      .mockResolvedValue({ moderation: { can_view: false } } as Awaited<
        ReturnType<typeof dropsService.findDropByIdOrThrow>
      >);
    await expect(getMemeCollaborationState(getRequest)).rejects.toThrow(
      'not available'
    );
    await expect(respondToMemeCollaboration(request)).rejects.toThrow(
      'not available'
    );
    expect(memeCollaborationsService.state).not.toHaveBeenCalled();
    expect(memeCollaborationsService.respond).not.toHaveBeenCalled();
  });

  it('requires access to the drop before reading or responding to an invitation', async () => {
    jest
      .mocked(dropsService.findDropByIdOrThrow)
      .mockRejectedValue(new Error('Drop not accessible'));
    await expect(getMemeCollaborationState(getRequest)).rejects.toThrow(
      'not accessible'
    );
    await expect(respondToMemeCollaboration(request)).rejects.toThrow(
      'not accessible'
    );
    expect(memeCollaborationsService.state).not.toHaveBeenCalled();
    expect(memeCollaborationsService.respond).not.toHaveBeenCalled();
  });
});
