import express, { ErrorRequestHandler } from 'express';
import { request, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { ApiCompliantException, NotFoundException } from '@/exceptions';
import * as auth from '@/api/auth/auth';
import { AuthenticationContext } from '@/auth-context';
import { ProfileProxyActionType } from '@/entities/IProfileProxyAction';
import { dropsDb } from '@/drops/drops.db';
import { dropCreationService } from '@/api/drops/drop-creation.api.service';
import router from './drops.routes';

jest.mock('passport', () => ({
  authenticate: jest.fn(
    () => (_req: unknown, _res: unknown, next: () => void) => next()
  )
}));
jest.mock('@/redis', () => ({
  getRedisClient: jest.fn().mockReturnValue(null)
}));
jest.mock('@/help-bot/help-bot-trigger.service', () => ({
  helpBotTriggerService: {
    handleCreatedDrop: jest.fn().mockResolvedValue(undefined)
  }
}));
jest.mock('@/api/drops/drop-creation.api.service', () => ({
  dropCreationService: {
    createDrop: jest.fn(),
    updateDrop: jest.fn(),
    findClientDropReplay: jest.fn()
  }
}));
jest.mock('@/api/device-signing/device-signed-writes.service', () => ({
  ...jest.requireActual('@/api/device-signing/device-signed-writes.service'),
  deviceSignedWritesService: {
    createDrop: jest.fn((_args: unknown, write: () => Promise<unknown>) =>
      write()
    ),
    mutateDrop: jest.fn((_args: unknown, write: () => Promise<unknown>) =>
      write()
    )
  }
}));
jest.mock('@/api/ws/ws-listeners-notifier', () => ({
  wsListenersNotifier: { notifyAboutDropUpdate: jest.fn() }
}));

const GRANTOR = 'grantor-profile';
const GRANTEE = 'grantee-profile';

function proxyContext(
  actions: Array<{
    type: ProfileProxyActionType;
    wave_allowlist: readonly string[] | null;
  }>
): AuthenticationContext {
  return new AuthenticationContext({
    authenticatedWallet: '0xgrantee',
    authenticatedProfileId: GRANTEE,
    roleProfileId: GRANTOR,
    activeProxyActions: actions.map((action, index) => ({
      id: `action-${index}`,
      type: action.type,
      credit_amount: null,
      credit_spent: null,
      wave_allowlist: action.wave_allowlist
    }))
  });
}

const restricted = () =>
  proxyContext([
    {
      type: ProfileProxyActionType.CREATE_DROP_TO_WAVE,
      wave_allowlist: ['wave-1']
    }
  ]);
const legacy = () =>
  proxyContext([
    { type: ProfileProxyActionType.CREATE_DROP_TO_WAVE, wave_allowlist: null }
  ]);
const readOnly = () =>
  proxyContext([
    { type: ProfileProxyActionType.READ_WAVE, wave_allowlist: null }
  ]);
const owner = () => AuthenticationContext.fromProfileId(GRANTOR);

function chatDrop(waveId: string, extra: Record<string, unknown> = {}) {
  return {
    wave_id: waveId,
    drop_type: 'CHAT',
    title: null,
    parts: [{ content: 'hello', media: [], quoted_drop: null }],
    referenced_nfts: [],
    mentioned_users: [],
    metadata: [],
    ...extra
  };
}

describe('drop write routes with a wave-scoped proxy grant', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/drops', router);
    const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
      const status =
        error instanceof ApiCompliantException ? error.getStatusCode() : 500;
      res
        .status(status)
        .json({ message: error instanceof Error ? error.message : 'Error' });
    };
    app.use(errors);
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  beforeEach(() => {
    jest
      .mocked(dropCreationService.createDrop)
      .mockResolvedValue({ id: 'new-drop' } as never);
    jest
      .mocked(dropCreationService.updateDrop)
      .mockResolvedValue({ drop: { id: 'drop-1' }, changed: false } as never);
    jest
      .mocked(dropCreationService.findClientDropReplay)
      .mockResolvedValue(null);
    jest
      .spyOn(dropsDb, 'findWaveIdByDropId')
      .mockImplementation(async (dropId: string) =>
        dropId === 'drop-in-wave-1'
          ? 'wave-1'
          : dropId === 'drop-in-wave-2'
            ? 'wave-2'
            : null
      );
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  function withContext(context: AuthenticationContext) {
    jest.spyOn(auth, 'getAuthenticationContext').mockResolvedValue(context);
  }

  function send(
    path: string,
    body: unknown
  ): Promise<{ status: number; json: any }> {
    return new Promise((resolve, reject) => {
      const req = request(
        `${baseUrl}${path}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Host: 'api.6529.io' }
        },
        (response) => {
          response.setEncoding('utf8');
          let text = '';
          response.on('data', (chunk: string) => (text += chunk));
          response.on('error', reject);
          response.on('end', () =>
            resolve({
              status: response.statusCode ?? 500,
              json: text ? JSON.parse(text) : null
            })
          );
        }
      );
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });
  }

  describe('POST /drops', () => {
    it('lets a restricted proxy post in a listed wave as the grantor', async () => {
      withContext(restricted());
      const res = await send('/drops', chatDrop('wave-1'));
      expect(res.status).toBe(200);
      expect(dropCreationService.createDrop).toHaveBeenCalledWith(
        expect.objectContaining({
          authorId: GRANTOR,
          representativeId: GRANTOR,
          createDropRequest: expect.objectContaining({ wave_id: 'wave-1' })
        }),
        expect.anything()
      );
    });

    it('refuses a restricted proxy in an unlisted wave before any write', async () => {
      withContext(restricted());
      const res = await send('/drops', chatDrop('wave-2'));
      expect(res.status).toBe(403);
      expect(res.json.message).toBe(
        'Proxy is not allowed to create drops in this wave'
      );
      expect(dropCreationService.createDrop).not.toHaveBeenCalled();
    });

    it('refuses a reply posted into an unlisted wave, whatever it replies to', async () => {
      withContext(restricted());
      const res = await send(
        '/drops',
        chatDrop('wave-2', {
          reply_to: { drop_id: 'drop-in-wave-1', drop_part_id: 1 }
        })
      );
      expect(res.status).toBe(403);
      expect(dropCreationService.createDrop).not.toHaveBeenCalled();
    });

    it('keeps a legacy unrestricted grant posting anywhere', async () => {
      withContext(legacy());
      expect((await send('/drops', chatDrop('wave-2'))).status).toBe(200);
      expect(dropCreationService.createDrop).toHaveBeenCalledTimes(1);
    });

    it('still refuses a proxy without the posting grant', async () => {
      withContext(readOnly());
      const res = await send('/drops', chatDrop('wave-1'));
      expect(res.status).toBe(403);
      expect(res.json.message).toBe(
        "Proxy doesn't have permission to create drops"
      );
      expect(dropCreationService.createDrop).not.toHaveBeenCalled();
    });

    it('does not change a user posting as themselves', async () => {
      withContext(owner());
      expect((await send('/drops', chatDrop('wave-2'))).status).toBe(200);
    });

    it('does not grant visibility: a listed wave the service cannot see still 404s', async () => {
      withContext(restricted());
      jest
        .mocked(dropCreationService.createDrop)
        .mockRejectedValue(new NotFoundException('Wave wave-1 not found'));
      const res = await send('/drops', chatDrop('wave-1'));
      expect(res.status).toBe(404);
    });
  });

  describe('POST /drops/:drop_id (edit)', () => {
    const edit = {
      parts: [{ content: 'edited', media: [], quoted_drop: null }]
    };

    it('lets a restricted proxy edit a drop in a listed wave', async () => {
      withContext(restricted());
      const res = await send('/drops/drop-in-wave-1', edit);
      expect(res.status).toBe(200);
      expect(dropCreationService.updateDrop).toHaveBeenCalledWith(
        expect.objectContaining({
          dropId: 'drop-in-wave-1',
          authorId: GRANTOR,
          representativeId: GRANTEE
        }),
        expect.anything()
      );
    });

    it('refuses a restricted proxy editing a drop in an unlisted wave', async () => {
      withContext(restricted());
      const res = await send('/drops/drop-in-wave-2', edit);
      expect(res.status).toBe(403);
      expect(res.json.message).toBe(
        'Proxy is not allowed to edit drops in this wave'
      );
      expect(dropCreationService.updateDrop).not.toHaveBeenCalled();
    });

    it('closes the old gap: a proxy without the posting grant cannot edit', async () => {
      withContext(readOnly());
      const res = await send('/drops/drop-in-wave-1', edit);
      expect(res.status).toBe(403);
      expect(dropCreationService.updateDrop).not.toHaveBeenCalled();
    });

    it('keeps 404 for an unknown drop ahead of the grant check', async () => {
      withContext(restricted());
      const res = await send('/drops/missing', edit);
      expect(res.status).toBe(404);
      expect(dropCreationService.updateDrop).not.toHaveBeenCalled();
    });

    it('keeps a legacy grant and the owner editing anywhere', async () => {
      withContext(legacy());
      expect((await send('/drops/drop-in-wave-2', edit)).status).toBe(200);
      withContext(owner());
      expect((await send('/drops/drop-in-wave-2', edit)).status).toBe(200);
    });
  });
});
