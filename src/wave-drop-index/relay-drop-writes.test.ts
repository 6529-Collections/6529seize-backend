import { DeviceEventKind } from '@/api/device-signing/device-event';
import { deviceSigningDb } from '@/api/device-signing/device-signing.db';
import { deviceSignedWritesService } from '@/api/device-signing/device-signed-writes.service';
import { dropCreationService } from '@/api/drops/drop-creation.api.service';
import { reactionsService } from '@/api/drops/reactions.service';
import { wsListenersNotifier } from '@/api/ws/ws-listeners-notifier';
import { dropsDb } from '@/drops/drops.db';
import { helpBotTriggerService } from '@/help-bot/help-bot-trigger.service';
import {
  TEST_GRANT_ID,
  TEST_WALLET,
  testGrantProof
} from '@/tests/fixtures/relay-events.fixture';
import { IngestedEvent } from './drop-index.db';
import { RelayWriteInput } from './relay-drop-applier';
import { relayDropWrites } from './relay-drop-writes';

jest.mock('@/api/device-signing/device-signing.db', () => ({
  deviceSigningDb: { findGrantById: jest.fn(), insertGrant: jest.fn() }
}));
jest.mock('@/api/device-signing/device-signed-writes.service', () => ({
  deviceSignedWritesService: { createDrop: jest.fn(), mutateDrop: jest.fn() }
}));
jest.mock('@/api/drops/drop-creation.api.service', () => ({
  dropCreationService: {
    createDrop: jest.fn(),
    updateDrop: jest.fn(),
    deleteDropById: jest.fn()
  }
}));
jest.mock('@/api/drops/reactions.service', () => ({
  reactionsService: { addReaction: jest.fn(), removeReaction: jest.fn() }
}));
jest.mock('@/api/ws/ws-listeners-notifier', () => ({
  wsListenersNotifier: { notifyAboutDropUpdate: jest.fn() }
}));
jest.mock('@/drops/drops.db', () => ({
  dropsDb: { findDropById: jest.fn(), findWaveIdByDropId: jest.fn() }
}));
jest.mock('@/help-bot/help-bot-trigger.service', () => ({
  helpBotTriggerService: { handleCreatedDrop: jest.fn() }
}));
jest.mock('@/identities/identities.db', () => ({
  identitiesDb: { getProfileIdByWallet: jest.fn() }
}));

const WAVE = 'wave-1';
const POST = {
  wave_id: WAVE,
  drop_type: 'CHAT',
  title: null,
  parts: [{ content: 'gm', media: [], quoted_drop: null }],
  referenced_nfts: [],
  mentioned_users: [],
  metadata: []
};

function anInput(notify = true): RelayWriteInput {
  return {
    event: {
      author: TEST_WALLET,
      wave: WAVE
    } as unknown as IngestedEvent,
    profileId: 'profile-1',
    envelope: {
      grant_id: TEST_GRANT_ID,
      seq: 3,
      claimed_time: 1_000,
      signature: `0x${'ab'.repeat(64)}`
    },
    times: { signedAt: 1_000, seenAt: 2_000, anchor: 0 },
    notify
  };
}

/** Runs the write callback the signed-write service is handed. */
function signedRunsWrite() {
  jest
    .mocked(deviceSignedWritesService.createDrop)
    .mockImplementation(async (_target, write) => write());
  jest
    .mocked(deviceSignedWritesService.mutateDrop)
    .mockImplementation(async (_target, write) => write());
}

describe('relayDropWrites', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    signedRunsWrite();
  });

  it("creates a post as its author under the event's id, signature and times", async () => {
    jest.mocked(dropsDb.findDropById).mockResolvedValue(null);
    jest
      .mocked(dropCreationService.createDrop)
      .mockResolvedValue({ id: 'drop-new' } as never);
    const input = anInput();
    await expect(
      relayDropWrites.createDrop(input, 'drop-new', POST as never)
    ).resolves.toBe('drop-new');
    const [target, , ctx] = jest.mocked(deviceSignedWritesService.createDrop)
      .mock.calls[0];
    expect(target).toMatchObject({
      envelope: input.envelope,
      waveId: WAVE,
      body: POST
    });
    expect(ctx).toMatchObject({
      relayEvent: { signedAt: 1_000, seenAt: 2_000, anchor: 0 }
    });
    expect(ctx.authenticationContext.getActingAsId()).toBe('profile-1');
    expect(ctx.authenticationContext.isAuthenticatedAsProxy()).toBe(false);
    expect(
      jest.mocked(dropCreationService.createDrop).mock.calls[0][0]
    ).toMatchObject({
      authorId: 'profile-1',
      representativeId: 'profile-1',
      newDropId: 'drop-new',
      createDropRequest: { author: { external_id: 'profile-1' }, wave_id: WAVE }
    });
    expect(helpBotTriggerService.handleCreatedDrop).toHaveBeenCalled();
  });

  it('records the signed event of a post an earlier try wrote, writing nothing else', async () => {
    jest
      .mocked(dropsDb.findDropById)
      .mockResolvedValue({ id: 'drop-new' } as never);
    await expect(
      relayDropWrites.createDrop(anInput(), 'drop-new', POST as never)
    ).resolves.toBe('drop-new');
    expect(deviceSignedWritesService.createDrop).toHaveBeenCalledTimes(1);
    expect(dropCreationService.createDrop).not.toHaveBeenCalled();
  });

  it('tries again a post saved but not read back', async () => {
    jest.mocked(dropsDb.findDropById).mockResolvedValue(null);
    jest
      .mocked(dropCreationService.createDrop)
      .mockRejectedValue(
        Object.assign(new Error('saved'), { code: 'DROP_SAVED_REFRESH' })
      );
    const error = await relayDropWrites
      .createDrop(anInput(), 'drop-new', POST as never)
      .catch((e: unknown) => e);
    expect((error as Error).message).toBe(
      'the drop was saved but not read back'
    );
    expect(
      (error as { getStatusCode?: unknown }).getStatusCode
    ).toBeUndefined();
  });

  it("refuses what the API's validation refuses", async () => {
    await expect(
      relayDropWrites.createDrop(anInput(), 'drop-new', {
        ...POST,
        parts: [{ content: ' ', media: [] }]
      } as never)
    ).rejects.toMatchObject({
      message: expect.stringMatching(/content, media/)
    });
    await expect(
      relayDropWrites.react(anInput(), 'drop-1', '')
    ).rejects.toBeDefined();
    expect(dropCreationService.createDrop).not.toHaveBeenCalled();
    expect(reactionsService.addReaction).not.toHaveBeenCalled();
  });

  it("edits a drop of the event's wave only, and tells sockets of a change", async () => {
    jest.mocked(dropsDb.findWaveIdByDropId).mockResolvedValue('wave-2');
    await expect(
      relayDropWrites.updateDrop(anInput(), 'drop-1', {
        parts: POST.parts
      } as never)
    ).rejects.toMatchObject({ message: expect.stringMatching(/another wave/) });
    jest.mocked(dropsDb.findWaveIdByDropId).mockResolvedValue(WAVE);
    jest
      .mocked(dropCreationService.updateDrop)
      .mockResolvedValue({ drop: { id: 'drop-1' }, changed: true } as never);
    await relayDropWrites.updateDrop(anInput(), 'drop-1', {
      parts: POST.parts
    } as never);
    expect(
      jest.mocked(deviceSignedWritesService.mutateDrop).mock.calls[0][0]
    ).toMatchObject({
      kind: DeviceEventKind.EDIT,
      dropId: 'drop-1',
      waveId: WAVE
    });
    expect(wsListenersNotifier.notifyAboutDropUpdate).toHaveBeenCalled();
  });

  it('deletes and reacts through the signed path', async () => {
    await relayDropWrites.deleteDrop(anInput(), 'drop-1');
    await relayDropWrites.react(anInput(), 'drop-1', ':fire:');
    await relayDropWrites.react(anInput(), 'drop-1', null);
    expect(
      jest
        .mocked(deviceSignedWritesService.mutateDrop)
        .mock.calls.map(([target]) => [target.kind, target.body])
    ).toEqual([
      [DeviceEventKind.TOMBSTONE, null],
      [DeviceEventKind.REACT, { on: true, reaction: ':fire:' }],
      [DeviceEventKind.REACT, { on: false }]
    ]);
    expect(dropCreationService.deleteDropById).toHaveBeenCalledWith(
      { id: 'drop-1' },
      expect.anything()
    );
    expect(reactionsService.addReaction).toHaveBeenCalledWith(
      'drop-1',
      'profile-1',
      ':fire:',
      expect.anything(),
      { notify: true }
    );
    expect(reactionsService.removeReaction).toHaveBeenCalledWith(
      'drop-1',
      'profile-1',
      expect.anything()
    );
  });

  it.each([
    [false, 'history'],
    [true, 'a live event']
  ])(
    'passes notify %s to every write that notifies, for %s',
    async (notify) => {
      jest.mocked(dropsDb.findDropById).mockResolvedValue(null);
      jest
        .mocked(dropCreationService.createDrop)
        .mockResolvedValue({ id: 'drop-new' } as never);
      jest.mocked(dropsDb.findWaveIdByDropId).mockResolvedValue(WAVE);
      jest
        .mocked(dropCreationService.updateDrop)
        .mockResolvedValue({ drop: { id: 'drop-1' }, changed: true } as never);
      await relayDropWrites.createDrop(
        anInput(notify),
        'drop-new',
        POST as never
      );
      await relayDropWrites.updateDrop(anInput(notify), 'drop-1', {
        parts: POST.parts
      } as never);
      await relayDropWrites.react(anInput(notify), 'drop-1', ':fire:');
      expect(
        jest.mocked(dropCreationService.createDrop).mock.calls[0][0]
      ).toMatchObject({
        newDropId: 'drop-new',
        notify
      });
      // Drop creation takes no activity credit request any more.
      expect(
        jest.mocked(dropCreationService.createDrop).mock.calls[0][0]
      ).not.toHaveProperty('requestDailyActivityCredit');
      // History wakes no help bot.
      expect(
        jest.mocked(helpBotTriggerService.handleCreatedDrop).mock.calls
      ).toHaveLength(notify ? 1 : 0);
      expect(
        jest.mocked(dropCreationService.updateDrop).mock.calls[0][0]
      ).toMatchObject({ dropId: 'drop-1', notify });
      expect(
        jest.mocked(reactionsService.addReaction).mock.calls[0][4]
      ).toEqual({ notify });
      // Sockets hear of the edit either way.
      expect(wsListenersNotifier.notifyAboutDropUpdate).toHaveBeenCalled();
    }
  );

  it("stores a grant 6529.io doesn't hold, once", async () => {
    jest.mocked(deviceSigningDb.findGrantById).mockResolvedValueOnce(null);
    await relayDropWrites.ensureGrant(testGrantProof());
    expect(
      jest.mocked(deviceSigningDb.insertGrant).mock.calls[0][0]
    ).toMatchObject({
      id: TEST_GRANT_ID,
      wallet: TEST_WALLET,
      key_type: 'ed25519',
      scopes: 'post,edit,delete,react',
      domain: '6529 Desktop',
      chain_id: 1,
      issued_at: 1792324800 * 1000,
      expires_at: 1807876800 * 1000,
      revoked_at: null
    });
    jest
      .mocked(deviceSigningDb.findGrantById)
      .mockResolvedValueOnce({ id: TEST_GRANT_ID } as never);
    await relayDropWrites.ensureGrant(testGrantProof());
    expect(deviceSigningDb.insertGrant).toHaveBeenCalledTimes(1);
  });
});
