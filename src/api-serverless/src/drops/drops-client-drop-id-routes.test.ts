import express, { ErrorRequestHandler } from 'express';
import { request, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import {
  ApiCompliantException,
  CustomApiCompliantException
} from '@/exceptions';
import * as auth from '@/api/auth/auth';
import { AuthenticationContext } from '@/auth-context';
import { wavesApiDb } from '@/api/waves/waves.api.db';
import { identityFetcher } from '@/api/identities/identity.fetcher';
import { dropCreationService } from '@/api/drops/drop-creation.api.service';
import { dropSignatureVerifier } from '@/api/drops/drop-signature-verifier';
import { dropHasher } from '@/api/drops/drop-hasher';
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
    findClientDropReplay: jest.fn()
  }
}));

const CLIENT_DROP_ID = '0b7f3c52-8f2e-4b8e-9a51-0c1e2d3f4a5b';
const WAVE_ID = 'signed-wave';
const TERMS = 'Terms of the signed wave';
const SIGNER = '0x1111111111111111111111111111111111111111';

/** A wallet-signed (non-device) participatory entry. */
function entry(extra: Record<string, unknown> = {}) {
  return {
    wave_id: WAVE_ID,
    drop_type: 'PARTICIPATORY',
    title: 'Entry',
    parts: [{ content: 'entry', media: [], quoted_drop: null }],
    referenced_nfts: [],
    mentioned_users: [],
    metadata: [],
    signature: '0xsignature',
    signer_address: SIGNER,
    ...extra
  };
}

describe('POST /drops with client_drop_id (waves R11-5)', () => {
  let server: Server;
  let baseUrl: string;
  /** The body the wallet actually signed; any other body fails to verify. */
  let signedHash: string;

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
    signedHash = dropHasher.hash({
      drop: entry({ client_drop_id: CLIENT_DROP_ID }) as never,
      termsOfService: TERMS
    });
    jest
      .spyOn(auth, 'getAuthenticationContext')
      .mockResolvedValue(AuthenticationContext.fromProfileId('author-profile'));
    jest.spyOn(wavesApiDb, 'findWaveById').mockResolvedValue({
      id: WAVE_ID,
      name: 'Signed wave',
      participation_signature_required: true,
      participation_terms: TERMS
    } as NonNullable<Awaited<ReturnType<typeof wavesApiDb.findWaveById>>>);
    jest
      .spyOn(identityFetcher, 'getIdentityAndConsolidationsByIdentityKey')
      .mockResolvedValue({ wallets: [{ wallet: SIGNER }] } as NonNullable<
        Awaited<
          ReturnType<
            typeof identityFetcher.getIdentityAndConsolidationsByIdentityKey
          >
        >
      >);
    jest
      .spyOn(dropSignatureVerifier, 'isDropSignedByAnyOfGivenWallets')
      .mockImplementation(
        async ({ drop, termsOfService }) =>
          dropHasher.hash({ drop, termsOfService }) === signedHash
      );
    jest
      .mocked(dropCreationService.createDrop)
      .mockResolvedValue({ id: 'new-drop' } as never);
    jest
      .mocked(dropCreationService.findClientDropReplay)
      .mockResolvedValue(null);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  function post(body: unknown): Promise<{ status: number; json: unknown }> {
    return new Promise((resolve, reject) => {
      const req = request(
        `${baseUrl}/drops`,
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

  it('creates the first attempt after checking the wallet signature', async () => {
    const response = await post(entry({ client_drop_id: CLIENT_DROP_ID }));

    expect(response.status).toBe(200);
    expect(response.json).toEqual({ id: 'new-drop' });
    expect(dropCreationService.findClientDropReplay).toHaveBeenCalledWith(
      {
        createDropRequest: expect.objectContaining({
          client_drop_id: CLIENT_DROP_ID
        }),
        authorId: 'author-profile'
      },
      expect.anything()
    );
    expect(
      dropSignatureVerifier.isDropSignedByAnyOfGivenWallets
    ).toHaveBeenCalledTimes(1);
    expect(dropCreationService.createDrop).toHaveBeenCalledTimes(1);
  });

  it('answers an identical wallet-signed retry with the same drop, before the signature check', async () => {
    jest
      .mocked(dropCreationService.findClientDropReplay)
      .mockResolvedValue({ id: 'first-drop' } as never);

    const response = await post(entry({ client_drop_id: CLIENT_DROP_ID }));

    expect(response.status).toBe(200);
    expect(response.json).toEqual({ id: 'first-drop' });
    expect(
      dropSignatureVerifier.isDropSignedByAnyOfGivenWallets
    ).not.toHaveBeenCalled();
    expect(dropCreationService.createDrop).not.toHaveBeenCalled();
  });

  it('looks a mixed-case id up in its normalized form', async () => {
    jest
      .mocked(dropCreationService.findClientDropReplay)
      .mockResolvedValue({ id: 'first-drop' } as never);

    const response = await post(
      entry({ client_drop_id: CLIENT_DROP_ID.toUpperCase() })
    );

    expect(response.json).toEqual({ id: 'first-drop' });
    expect(dropCreationService.findClientDropReplay).toHaveBeenCalledWith(
      expect.objectContaining({
        createDropRequest: expect.objectContaining({
          client_drop_id: CLIENT_DROP_ID
        })
      }),
      expect.anything()
    );
  });

  it.each([`{${CLIENT_DROP_ID}}`, `urn:uuid:${CLIENT_DROP_ID}`, 'not-a-uuid'])(
    'rejects the malformed id %s before any lookup',
    async (clientDropId) => {
      const response = await post(entry({ client_drop_id: clientDropId }));

      expect(response.status).toBe(400);
      expect(dropCreationService.findClientDropReplay).not.toHaveBeenCalled();
      expect(dropCreationService.createDrop).not.toHaveBeenCalled();
    }
  );

  it('refuses client_drop_id added to a body signed without it, creating nothing', async () => {
    // The wallet signed the body without client_drop_id.
    signedHash = dropHasher.hash({
      drop: entry() as never,
      termsOfService: TERMS
    });

    const response = await post(entry({ client_drop_id: CLIENT_DROP_ID }));

    expect(response.status).toBe(400);
    expect(response.json).toEqual({ message: 'Invalid drop signature' });
    expect(dropCreationService.createDrop).not.toHaveBeenCalled();
  });

  it('passes a changed body with a used id to the claim check, which refuses it', async () => {
    jest
      .mocked(dropCreationService.findClientDropReplay)
      .mockRejectedValue(
        new CustomApiCompliantException(
          409,
          'client_drop_id was already used for a different drop',
          'CLIENT_DROP_ID_REUSED'
        )
      );

    const response = await post(
      entry({
        client_drop_id: CLIENT_DROP_ID,
        parts: [{ content: 'changed entry', media: [], quoted_drop: null }]
      })
    );

    expect(response.status).toBe(409);
    expect(dropCreationService.createDrop).not.toHaveBeenCalled();
  });

  it('leaves creates without client_drop_id exactly as before', async () => {
    signedHash = dropHasher.hash({
      drop: entry() as never,
      termsOfService: TERMS
    });

    const response = await post(entry());

    expect(response.status).toBe(200);
    expect(dropCreationService.findClientDropReplay).not.toHaveBeenCalled();
    expect(dropCreationService.createDrop).toHaveBeenCalledTimes(1);
  });
});
