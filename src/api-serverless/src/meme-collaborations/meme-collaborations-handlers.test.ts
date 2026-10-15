import {
  inviteMemeCollaborators,
  getMemeCollaborationState,
  respondToMemeCollaboration
} from './meme-collaborations.handlers';
import { dropsService } from '@/api/drops/drops.api.service';
import { memeCollaborationsService } from '@/meme-collaborations/meme-collaborations.service';
import type {
  InviteMemeCollaboratorsRequest,
  GetMemeCollaborationStateRequest,
  RespondToMemeCollaborationRequest
} from '@/api/generated/routes/operations';
import { wsListenersNotifier } from '@/api/ws/ws-listeners-notifier';
import { sendIdentityPushNotifications } from '@/api/push-notifications/push-notifications.service';
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
  memeCollaborationsService: {
    state: jest.fn(),
    respond: jest.fn(),
    inviteExisting: jest.fn()
  }
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

it('returns committed acceptance despite a websocket failure and disables shared caching', async () => {
  jest
    .mocked(dropsService.findDropByIdOrThrow)
    .mockResolvedValue({ id: 'drop' } as Awaited<
      ReturnType<typeof dropsService.findDropByIdOrThrow>
    >);
  jest.mocked(memeCollaborationsService.respond).mockResolvedValue([12]);
  const state = {
    can_invite: false,
    managed: true,
    closed: false,
    artwork_hash: 'a'.repeat(64),
    terms_version: 'b'.repeat(64),
    acceptance_copy: 'Final',
    terms: null,
    artwork: undefined,
    collaborators: [],
    invitations: []
  };
  jest.mocked(memeCollaborationsService.state).mockResolvedValue(state);
  jest
    .mocked(wsListenersNotifier.notifyAboutDropUpdate)
    .mockRejectedValue(new Error('Websocket unavailable'));
  const setHeader = jest.fn();
  const req = {
    ...request,
    res: { setHeader }
  } as unknown as RespondToMemeCollaborationRequest;
  await expect(respondToMemeCollaboration(req)).resolves.toEqual(state);
  expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
  expect(sendIdentityPushNotifications).toHaveBeenCalledWith([12]);
  await getMemeCollaborationState(
    req as unknown as GetMemeCollaborationStateRequest
  );
  expect(setHeader).toHaveBeenCalledTimes(2);
});

it('appends invited IDs through the dedicated endpoint and returns viewer-scoped state', async () => {
  jest
    .mocked(dropsService.findDropByIdOrThrow)
    .mockResolvedValue({ id: 'drop' } as Awaited<
      ReturnType<typeof dropsService.findDropByIdOrThrow>
    >);
  jest.mocked(memeCollaborationsService.inviteExisting).mockResolvedValue([44]);
  jest.mocked(memeCollaborationsService.state).mockResolvedValue({
    can_invite: true,
    managed: true,
    closed: false,
    artwork_hash: 'hash',
    terms_version: 'terms',
    acceptance_copy: 'Final',
    terms: null,
    artwork: undefined,
    collaborators: [],
    invitations: []
  });
  const response = await inviteMemeCollaborators({
    params: { drop_id: 'drop' },
    body: { collaborator_ids: ['C'] }
  } as InviteMemeCollaboratorsRequest);
  expect(response.can_invite).toBe(true);
  expect(memeCollaborationsService.inviteExisting).toHaveBeenCalledWith(
    'drop',
    ['C'],
    expect.any(AuthenticationContext),
    expect.any(Object)
  );
  expect(sendIdentityPushNotifications).toHaveBeenCalledWith([44]);
});
it('rejects invitations before mutation when artwork cannot be viewed', async () => {
  jest
    .mocked(dropsService.findDropByIdOrThrow)
    .mockResolvedValue({ moderation: { can_view: false } } as Awaited<
      ReturnType<typeof dropsService.findDropByIdOrThrow>
    >);
  const inviteMock = jest.mocked(memeCollaborationsService.inviteExisting);
  inviteMock.mockClear();
  await expect(
    inviteMemeCollaborators({
      params: { drop_id: 'drop' },
      body: { collaborator_ids: ['C'] }
    } as InviteMemeCollaboratorsRequest)
  ).rejects.toThrow('not available');
  expect(inviteMock).not.toHaveBeenCalled();
});
