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
import { ForbiddenException } from '@/exceptions';
import type { DropEntity } from '@/entities/IDrop';

jest.mock('@/api/auth/auth', () => ({
  getAuthenticationContext: jest.fn(async () =>
    AuthenticationContext.fromProfileId('B')
  )
}));
jest.mock('@/api/drops/drops.api.service', () => ({
  dropsService: {
    findDropByIdOrThrow: jest.fn(),
    findViewableDropByIdOrThrow: jest.fn()
  }
}));
jest.mock('@/meme-collaborations/meme-collaborations.service', () => ({
  memeCollaborationsService: {
    state: jest.fn(),
    respond: jest.fn(),
    inviteExisting: jest.fn()
  }
}));
jest.mock('@/api/ws/ws-listeners-notifier', () => ({
  wsListenersNotifier: {
    notifyAboutDropUpdate: jest.fn(),
    notifyAboutIdentityNotificationsChanged: jest
      .fn()
      .mockResolvedValue(undefined)
  }
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

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(dropsService.findViewableDropByIdOrThrow).mockResolvedValue({
    id: 'drop',
    author_id: 'A'
  } as DropEntity);
});

describe('Collaboration API visibility', () => {
  it('does not reveal stored artwork behind moderation', async () => {
    jest
      .mocked(dropsService.findViewableDropByIdOrThrow)
      .mockRejectedValue(
        new ForbiddenException(
          'This artwork is not available for collaboration review'
        )
      );
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
      .mocked(dropsService.findViewableDropByIdOrThrow)
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
    .mockResolvedValue({ id: 'drop', author: { id: 'A' } } as Awaited<
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
    .mockResolvedValue({ id: 'drop', author: { id: 'A' } } as Awaited<
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
  expect(
    wsListenersNotifier.notifyAboutIdentityNotificationsChanged
  ).toHaveBeenCalledWith(['A', 'C']);
  expect(dropsService.findDropByIdOrThrow).not.toHaveBeenCalled();
});
it('rejects invitations before mutation when artwork cannot be viewed', async () => {
  jest
    .mocked(dropsService.findViewableDropByIdOrThrow)
    .mockRejectedValue(
      new ForbiddenException(
        'This artwork is not available for collaboration review'
      )
    );
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

it.each([
  { action: 'ACCEPT', artist_name: '   ' },
  { action: 'ACCEPT', artist_name: 'x'.repeat(201) },
  { action: 'DECLINE', artist_name: 'Artist B' },
  { action: 'CANCEL', artist_name: 'Artist B' }
])('rejects invalid or inapplicable credit-name input: %j', async (fields) => {
  jest
    .mocked(dropsService.findDropByIdOrThrow)
    .mockResolvedValue({ id: 'drop', author: { id: 'A' } } as Awaited<
      ReturnType<typeof dropsService.findDropByIdOrThrow>
    >);
  jest.mocked(memeCollaborationsService.respond).mockClear();
  await expect(
    respondToMemeCollaboration({
      ...request,
      body: { ...request.body, ...fields }
    } as RespondToMemeCollaborationRequest)
  ).rejects.toThrow();
  expect(memeCollaborationsService.respond).not.toHaveBeenCalled();
});

it.each(['ACCEPT', 'DECLINE', 'CANCEL'] as const)(
  'refreshes collaboration state for %s even when notifications are disabled',
  async (action) => {
    jest
      .mocked(dropsService.findDropByIdOrThrow)
      .mockResolvedValue({ id: 'drop', author: { id: 'A' } } as Awaited<
        ReturnType<typeof dropsService.findDropByIdOrThrow>
      >);
    jest.mocked(memeCollaborationsService.respond).mockResolvedValue([]);
    jest.mocked(memeCollaborationsService.state).mockResolvedValue({
      can_invite: false,
      artwork: undefined,
      managed: true,
      closed: false,
      artwork_hash: 'hash',
      terms_version: 'terms',
      acceptance_copy: 'Final',
      terms: null,
      collaborators: [],
      invitations: [
        {
          id: 'invitation',
          artist_name: null,
          status: action === 'ACCEPT' ? 'ACCEPTED' : 'CANCELLED',
          profile: { id: 'B', handle: 'b', display: 'b', pfp: null }
        }
      ]
    });
    jest
      .mocked(wsListenersNotifier.notifyAboutDropUpdate)
      .mockResolvedValue(undefined);
    jest.clearAllMocks();
    await respondToMemeCollaboration({
      ...request,
      body: { ...request.body, action }
    } as RespondToMemeCollaborationRequest);
    expect(
      wsListenersNotifier.notifyAboutIdentityNotificationsChanged
    ).toHaveBeenCalledWith(expect.arrayContaining(['A', 'B']));
    expect(wsListenersNotifier.notifyAboutDropUpdate).toHaveBeenCalledTimes(
      action === 'ACCEPT' ? 1 : 0
    );
  }
);

it('reads collaboration state without constructing a full drop', async () => {
  jest.mocked(memeCollaborationsService.state).mockResolvedValue({
    can_invite: false,
    managed: false,
    closed: false,
    artwork_hash: '',
    terms_version: '',
    acceptance_copy: 'Final',
    terms: null,
    artwork: undefined,
    collaborators: [],
    invitations: []
  });

  await getMemeCollaborationState(getRequest);

  expect(dropsService.findViewableDropByIdOrThrow).toHaveBeenCalledWith(
    {
      dropId: 'drop',
      unavailableMessage:
        'This artwork is not available for collaboration review'
    },
    expect.objectContaining({
      authenticationContext: expect.any(AuthenticationContext)
    })
  );
  expect(dropsService.findDropByIdOrThrow).not.toHaveBeenCalled();
});
