import {
  clientDropFingerprint,
  DropCreationApiService
} from '@/api/drops/drop-creation.api.service';
import { NewDropSchema } from '@/api/drops/drop.validator';
jest.mock('@/competitions/competition-entry-drop-hooks');
import { waveScoreService } from '@/api/waves/wave-score.service';
import { DropType } from '@/entities/IDrop';
import { helpBotDailyActivityCreditQueueService } from '@/help-bot/help-bot-daily-activity-credit-queue.service';
import { DropClientIdTakenError } from '@/drops/drop-client-ids.db';
import { DropClientIdEntity } from '@/entities/IDropClientId';
import { NotFoundException } from '@/exceptions';
import { sendIdentityPushNotifications } from '@/api/push-notifications/push-notifications.service';

jest.mock('@/api/waves/wave-unread-cache', () => ({
  invalidateWaveUnreadCacheForWave: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('@/api/push-notifications/push-notifications.service', () => ({
  sendIdentityPushNotifications: jest.fn().mockResolvedValue(undefined)
}));

const CLIENT_DROP_ID = '0b7f3c52-8f2e-4b8e-9a51-0c1e2d3f4a5b';
const AUTHOR = 'author-profile';

const model = {
  drop_id: null,
  wave_id: 'wave-1',
  author_id: AUTHOR,
  author_identity: AUTHOR,
  drop_type: DropType.CHAT,
  title: null,
  signature: null,
  reply_to: null,
  parts: [{ content: 'gm', quoted_drop: null, media: [] }],
  metadata: [],
  mentioned_users: [],
  mentioned_waves: [],
  mentioned_groups: [],
  referenced_nfts: []
};
const fingerprint = clientDropFingerprint({ wave_id: 'wave-1' } as never);

function claim(overrides: Partial<DropClientIdEntity> = {}) {
  return {
    author_id: AUTHOR,
    client_drop_id: CLIENT_DROP_ID,
    drop_id: 'first-drop',
    wave_id: 'wave-1',
    content_fingerprint: fingerprint,
    created_at: 1,
    ...overrides
  };
}

function setup({
  claimed = null,
  claimedAfterRace = null,
  insertError = null
}: {
  claimed?: DropClientIdEntity | null;
  claimedAfterRace?: DropClientIdEntity | null;
  insertError?: Error | null;
} = {}) {
  const connection = { connection: 'tx' };
  const transactions: unknown[] = [];
  const dropsDb = {
    executeNativeQueriesInTransaction: jest.fn(
      async (
        callback: (connection: unknown) => Promise<unknown>,
        options?: unknown
      ) => {
        transactions.push(options);
        return callback(connection);
      }
    )
  };
  const createOrUpdateDrop = {
    preResolveIdentityNomination: jest.fn().mockResolvedValue(null),
    preparePrePublication: jest.fn().mockResolvedValue({
      dropId: 'new-drop',
      operation: 'CREATE'
    }),
    execute: jest.fn().mockResolvedValue({
      drop_id: 'new-drop',
      pending_push_notification_ids: [7]
    })
  };
  const dropsService = {
    findDropByIdOrThrow: jest.fn(async ({ dropId }: { dropId: string }) => ({
      id: dropId,
      wave: { id: 'wave-1' }
    }))
  };
  const wsListenersNotifier = {
    notifyAboutDropUpdate: jest.fn().mockResolvedValue(undefined)
  };
  const clientIdsDb = {
    find: jest
      .fn()
      .mockResolvedValueOnce(claimed)
      .mockResolvedValueOnce(claimedAfterRace),
    insert: jest.fn(async () => {
      if (insertError) throw insertError;
    })
  };
  const service = new DropCreationApiService(
    dropsService as never,
    dropsDb as never,
    { createDropApiToUseCaseModel: jest.fn().mockReturnValue(model) } as never,
    createOrUpdateDrop as never,
    {} as never,
    wsListenersNotifier as never,
    { findByDropId: jest.fn().mockResolvedValue([]) } as never,
    {} as never,
    { createPollForDrop: jest.fn().mockResolvedValue(undefined) } as never,
    undefined,
    undefined,
    undefined,
    clientIdsDb as never
  );
  const create = (clientDropId: string | null = CLIENT_DROP_ID) =>
    service.createDrop(
      {
        createDropRequest: {
          wave_id: 'wave-1',
          ...(clientDropId ? { client_drop_id: clientDropId } : {})
        } as never,
        authorId: AUTHOR,
        representativeId: AUTHOR
      },
      { timer: undefined } as never
    );
  return {
    connection,
    transactions,
    createOrUpdateDrop,
    dropsService,
    wsListenersNotifier,
    clientIdsDb,
    create
  };
}

describe('DropCreationApiService.createDrop with client_drop_id (R11-5)', () => {
  beforeEach(() => {
    jest
      .spyOn(helpBotDailyActivityCreditQueueService, 'enqueueRequest')
      .mockResolvedValue(false);
    jest
      .spyOn(waveScoreService, 'requestWaveScoreRefreshBestEffort')
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it('behaves as before without a client_drop_id', async () => {
    const { create, clientIdsDb, wsListenersNotifier } = setup();

    const drop = await create(null);

    expect(clientIdsDb.find).not.toHaveBeenCalled();
    expect(clientIdsDb.insert).not.toHaveBeenCalled();
    expect(drop).not.toHaveProperty('client_drop_id');
    expect(wsListenersNotifier.notifyAboutDropUpdate).toHaveBeenCalledTimes(1);
  });

  it('claims a new id in the drop transaction and echoes it to the author and the broadcast', async () => {
    const { create, clientIdsDb, connection, wsListenersNotifier } = setup();

    const drop = await create(CLIENT_DROP_ID.toUpperCase());

    expect(clientIdsDb.find).toHaveBeenCalledWith(
      { authorId: AUTHOR, clientDropId: CLIENT_DROP_ID },
      expect.anything()
    );
    expect(clientIdsDb.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        author_id: AUTHOR,
        client_drop_id: CLIENT_DROP_ID,
        drop_id: 'new-drop',
        wave_id: 'wave-1',
        content_fingerprint: fingerprint
      }),
      { timer: undefined, connection }
    );
    expect(drop).toMatchObject({
      id: 'new-drop',
      client_drop_id: CLIENT_DROP_ID
    });
    expect(wsListenersNotifier.notifyAboutDropUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'new-drop',
        client_drop_id: CLIENT_DROP_ID
      }),
      expect.anything()
    );
  });

  it('returns the first drop for a retry without moderating, writing or broadcasting again', async () => {
    const {
      create,
      createOrUpdateDrop,
      wsListenersNotifier,
      transactions,
      dropsService
    } = setup({ claimed: claim() });

    const drop = await create();

    expect(drop).toMatchObject({
      id: 'first-drop',
      client_drop_id: CLIENT_DROP_ID
    });
    expect(createOrUpdateDrop.preparePrePublication).not.toHaveBeenCalled();
    expect(createOrUpdateDrop.execute).not.toHaveBeenCalled();
    expect(wsListenersNotifier.notifyAboutDropUpdate).not.toHaveBeenCalled();
    expect(sendIdentityPushNotifications).not.toHaveBeenCalled();
    // The first attempt may have committed moments ago: read the writer.
    expect(transactions).toEqual([{ isolationLevel: 'READ COMMITTED' }]);
    expect(dropsService.findDropByIdOrThrow).toHaveBeenCalledWith(
      { dropId: 'first-drop', skipEligibilityCheck: true },
      expect.objectContaining({ connection: expect.anything() })
    );
  });

  it.each([
    ['different content', claim({ content_fingerprint: 'other' })],
    ['a different wave', claim({ wave_id: 'wave-2' })]
  ])('rejects a reused id with %s', async (_label, claimed) => {
    const { create, createOrUpdateDrop } = setup({ claimed });

    await expect(create()).rejects.toMatchObject({
      code: 'CLIENT_DROP_ID_REUSED'
    });
    expect(createOrUpdateDrop.execute).not.toHaveBeenCalled();
  });

  it('rejects a reused id whose drop no longer exists', async () => {
    const { create, dropsService } = setup({ claimed: claim() });
    dropsService.findDropByIdOrThrow.mockRejectedValueOnce(
      new NotFoundException('gone')
    );

    await expect(create()).rejects.toMatchObject({
      code: 'CLIENT_DROP_ID_REUSED'
    });
  });

  it('returns the winner of a concurrent duplicate and skips post-commit work', async () => {
    const { create, wsListenersNotifier } = setup({
      claimedAfterRace: claim(),
      insertError: new DropClientIdTakenError()
    });

    const drop = await create();

    expect(drop).toMatchObject({
      id: 'first-drop',
      client_drop_id: CLIENT_DROP_ID
    });
    expect(wsListenersNotifier.notifyAboutDropUpdate).not.toHaveBeenCalled();
    expect(sendIdentityPushNotifications).not.toHaveBeenCalled();
  });

  it('surfaces other transaction failures unchanged', async () => {
    const failure = new Error('deadlock');
    const { create, clientIdsDb } = setup({ insertError: failure });

    await expect(create()).rejects.toBe(failure);
    expect(clientIdsDb.find).toHaveBeenCalledTimes(1);
  });
});

describe('client_drop_id request contract', () => {
  it('fingerprints only what the client sent, without the id, envelope or server fields', () => {
    const request = {
      wave_id: 'wave-1',
      parts: [{ content: 'gm', media: [] }],
      client_drop_id: CLIENT_DROP_ID
    };
    const same = clientDropFingerprint(request as never);

    expect(
      clientDropFingerprint({
        ...request,
        client_drop_id: undefined,
        device_signature: { seq: 9 },
        author: { external_id: 'x' }
      } as never)
    ).toBe(same);
    expect(
      clientDropFingerprint({
        ...request,
        parts: [{ content: 'gm!', media: [] }]
      } as never)
    ).not.toBe(same);
  });

  it('accepts only the plain UUID form and stores it lowercase', () => {
    const body = (clientDropId: string) => ({
      wave_id: 'wave-1',
      parts: [{ content: 'gm', media: [] }],
      referenced_nfts: [],
      mentioned_users: [],
      metadata: [],
      client_drop_id: clientDropId
    });
    const valid = NewDropSchema.validate(body(CLIENT_DROP_ID.toUpperCase()));
    expect(valid.error).toBeUndefined();
    expect(valid.value.client_drop_id).toBe(CLIENT_DROP_ID);
    for (const bad of [
      `{${CLIENT_DROP_ID}}`,
      `urn:uuid:${CLIENT_DROP_ID}`,
      CLIENT_DROP_ID.split('-').join(''),
      'not-a-uuid'
    ]) {
      expect(NewDropSchema.validate(body(bad)).error).toBeDefined();
    }
  });
});
