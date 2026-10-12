import express, { ErrorRequestHandler } from 'express';
import { request, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { ApiCompliantException } from '@/exceptions';
import * as auth from '@/api/auth/auth';
import { AuthenticationContext } from '@/auth-context';
import { dropCreationService } from '@/api/drops/drop-creation.api.service';
import { deviceSigningDb } from '@/api/device-signing/device-signing.db';
import { identitiesDb } from '@/identities/identities.db';
import { DeviceGrantEntity } from '@/entities/IDeviceGrant';
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
  dropCreationService: { createDrop: jest.fn() }
}));

// Shared DN1 contract vectors.
const NOW = 1760000000000;
const WALLET = '0x1111111111111111111111111111111111111111';
const GRANT_ID =
  '0xe0b23044ded5e97599cd0d3f4ae0234df6aa13c90c633a9f12d9f597ea7f20bc';
const DEVICE_KEY =
  '0xd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
const VECTOR_EVENT_ID =
  '0x85085439fde88ab7c9c2979f922c1eb9d3b7f528819e6e7c3befad77f935b02a';
const VECTOR_BODY = {
  wave_id: '4a1e0e2c-7a7d-4b38-9c0b-2f1d6d1c9a10',
  title: null,
  parts: [{ content: 'gm é😀 "q"', media: [], quoted_drop: null }],
  referenced_nfts: [],
  mentioned_users: [],
  metadata: [],
  reply_to: {
    drop_id: 'b0c5d6e7-1111-4222-8333-944455556666',
    drop_part_id: 1
  },
  signature: null,
  is_safe_signature: false,
  signer_address: WALLET,
  drop_type: 'CHAT',
  hide_link_preview: false
};
const VECTOR_DEVICE_SIGNATURE = {
  grant_id: GRANT_ID,
  seq: 1760000000000,
  claimed_time: 1760000000123,
  signature:
    '0xf8c7552edc9013ef82b331037b34dd7ae20fa4a6aab9feea1d906c6ee1b906db03e20254917fce0832ce5768e3a676fad76cb9d47d12b5e74536aa11e9e9cf04'
};

const grant: DeviceGrantEntity = {
  id: GRANT_ID,
  wallet: WALLET,
  key_type: 'ed25519',
  device_key: DEVICE_KEY,
  scopes: 'post,edit,delete,react',
  device_label: 'Browser',
  domain: '6529.io',
  message: 'message',
  wallet_signature: '0xsig',
  chain_id: 1,
  issued_at: NOW - 1000,
  expires_at: NOW + 86_400_000,
  created_at: NOW - 1000,
  revoked_at: null,
  last_used_at: null
};

describe('POST /drops device signatures', () => {
  let server: Server;
  let baseUrl: string;
  const createdDrop = { id: 'created-drop' };

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/drops', router);
    const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
      if (error instanceof ApiCompliantException) {
        res.status(error.getStatusCode()).json({
          error: error.message,
          ...(error.code ? { code: error.code } : {})
        });
        return;
      }
      res.status(500).json({ error: 'Something went wrong...' });
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
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    jest.spyOn(auth, 'getAuthenticationContext').mockResolvedValue(
      new AuthenticationContext({
        authenticatedWallet: WALLET,
        authenticatedProfileId: 'author-profile',
        roleProfileId: null,
        activeProxyActions: []
      })
    );
    jest
      .mocked(dropCreationService.createDrop)
      .mockResolvedValue(
        createdDrop as Awaited<
          ReturnType<typeof dropCreationService.createDrop>
        >
      );
    jest
      .spyOn(identitiesDb, 'getProfileIdByWallet')
      .mockResolvedValue('author-profile');
    jest.spyOn(deviceSigningDb, 'findGrantById').mockResolvedValue(grant);
    jest.spyOn(deviceSigningDb, 'reserveEvent').mockResolvedValue(true);
    jest
      .spyOn(deviceSigningDb, 'deleteReservedEvent')
      .mockResolvedValue(undefined);
    jest
      .spyOn(deviceSigningDb, 'attachEventToDrop')
      .mockResolvedValue(undefined);
    jest
      .spyOn(deviceSigningDb, 'upsertDropAuthorSignature')
      .mockResolvedValue(undefined);
    jest
      .spyOn(deviceSigningDb, 'touchGrantLastUsed')
      .mockResolvedValue(undefined);
    jest
      .spyOn(deviceSigningDb, 'executeNativeQueriesInTransaction')
      .mockImplementation(async (fn) => fn({ connection: 'tx' }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  function post(
    body: unknown
  ): Promise<{ status: number; json: () => Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const req = request(
        `${baseUrl}/drops`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Host: 'api.6529.io' }
        },
        (response) => {
          response.setEncoding('utf8');
          let responseBody = '';
          response.on('data', (chunk: string) => {
            responseBody += chunk;
          });
          response.on('error', reject);
          response.on('end', () =>
            resolve({
              status: response.statusCode ?? 500,
              json: () => JSON.parse(responseBody) as Record<string, unknown>
            })
          );
        }
      );
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });
  }

  function expectedCreateRequest() {
    return expect.objectContaining({
      authorId: 'author-profile',
      representativeId: 'author-profile',
      createDropRequest: expect.objectContaining({
        author: { external_id: 'author-profile' },
        wave_id: VECTOR_BODY.wave_id,
        reply_to: VECTOR_BODY.reply_to,
        parts: [expect.objectContaining({ content: 'gm é😀 "q"' })]
      })
    });
  }

  it('creates unsigned drops exactly as before without touching device tables', async () => {
    const response = await post(VECTOR_BODY);

    expect(response.status).toBe(200);
    expect(response.json()).toEqual(createdDrop);
    expect(dropCreationService.createDrop).toHaveBeenCalledTimes(1);
    expect(dropCreationService.createDrop).toHaveBeenCalledWith(
      expectedCreateRequest(),
      expect.any(Object)
    );
    const [{ createDropRequest }] = jest.mocked(dropCreationService.createDrop)
      .mock.calls[0];
    expect(createDropRequest).not.toHaveProperty('device_signature');
    expect(deviceSigningDb.findGrantById).not.toHaveBeenCalled();
    expect(deviceSigningDb.reserveEvent).not.toHaveBeenCalled();
    expect(
      deviceSigningDb.executeNativeQueriesInTransaction
    ).not.toHaveBeenCalled();
  });

  it('verifies, stores and links a device signed drop (contract vector)', async () => {
    const response = await post({
      ...VECTOR_BODY,
      device_signature: VECTOR_DEVICE_SIGNATURE
    });

    expect(response.status).toBe(200);
    expect(response.json()).toEqual(createdDrop);
    expect(dropCreationService.createDrop).toHaveBeenCalledWith(
      expectedCreateRequest(),
      expect.any(Object)
    );
    const [{ createDropRequest }] = jest.mocked(dropCreationService.createDrop)
      .mock.calls[0];
    expect(createDropRequest).not.toHaveProperty('device_signature');
    expect(deviceSigningDb.reserveEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        id: VECTOR_EVENT_ID,
        kind: 1,
        author: WALLET,
        profile_id: 'author-profile',
        body_size: 418,
        seq: 1760000000000
      }),
      expect.anything()
    );
    expect(deviceSigningDb.attachEventToDrop).toHaveBeenCalledWith(
      { eventId: VECTOR_EVENT_ID, dropId: 'created-drop' },
      expect.anything()
    );
    expect(deviceSigningDb.upsertDropAuthorSignature).toHaveBeenCalledWith(
      { dropId: 'created-drop', eventId: VECTOR_EVENT_ID, signedAt: NOW },
      expect.anything()
    );
  });

  it('rejects a body changed after signing without creating the drop', async () => {
    const response = await post({
      ...VECTOR_BODY,
      title: 'changed',
      device_signature: VECTOR_DEVICE_SIGNATURE
    });

    expect(response.status).toBe(400);
    expect(response.json()).toEqual({
      error: 'Invalid device signature: signature does not verify',
      code: 'INVALID_DEVICE_SIGNATURE'
    });
    expect(dropCreationService.createDrop).not.toHaveBeenCalled();
    expect(deviceSigningDb.reserveEvent).not.toHaveBeenCalled();
  });

  it('rejects a replayed device signature', async () => {
    jest.spyOn(deviceSigningDb, 'reserveEvent').mockResolvedValue(false);

    const response = await post({
      ...VECTOR_BODY,
      device_signature: VECTOR_DEVICE_SIGNATURE
    });

    expect(response.status).toBe(400);
    expect(String(response.json().error)).toMatch(
      /^Invalid device signature: /
    );
    expect(dropCreationService.createDrop).not.toHaveBeenCalled();
  });

  it('rejects a null device_signature as malformed', async () => {
    const response = await post({ ...VECTOR_BODY, device_signature: null });

    expect(response.status).toBe(400);
    expect(String(response.json().error)).toMatch(
      /^Invalid device signature: malformed envelope/
    );
    expect(dropCreationService.createDrop).not.toHaveBeenCalled();
  });

  it('releases the reserved event when the create fails', async () => {
    jest
      .mocked(dropCreationService.createDrop)
      .mockRejectedValue(new Error('create failed'));

    const response = await post({
      ...VECTOR_BODY,
      device_signature: VECTOR_DEVICE_SIGNATURE
    });

    expect(response.status).toBe(500);
    expect(deviceSigningDb.deleteReservedEvent).toHaveBeenCalledWith(
      VECTOR_EVENT_ID,
      expect.anything()
    );
    expect(deviceSigningDb.attachEventToDrop).not.toHaveBeenCalled();
  });
});
