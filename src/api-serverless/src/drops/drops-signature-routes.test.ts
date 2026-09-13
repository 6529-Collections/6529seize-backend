import express, { ErrorRequestHandler } from 'express';
import { request, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { ethers } from 'ethers';
import { ApiCompliantException } from '@/exceptions';
import * as auth from '@/api/auth/auth';
import { wavesApiDb } from '@/api/waves/waves.api.db';
import { identityFetcher } from '@/api/identities/identity.fetcher';
import { dropCreationService } from '@/api/drops/drop-creation.api.service';
import { dropSignatureVerifier } from '@/api/drops/drop-signature-verifier';
import { ApiDropType } from '@/api/generated/models/ApiDropType';
import { getRedisClient } from '@/redis';
import fixture from '@/api/wallet-signatures/fixtures/memes-submission-v1.json';
import {
  clearStructuredWalletSignatureReplayCacheForTests,
  getStructuredWalletSignatureAudienceForHost
} from '@/api/wallet-signatures/structured-wallet-signatures';
import router from './drops.routes';

jest.mock('passport', () => ({
  authenticate: jest.fn(
    () => (_req: unknown, _res: unknown, next: () => void) => next()
  )
}));
jest.mock('@/redis', () => ({ getRedisClient: jest.fn() }));
jest.mock('@/help-bot/help-bot-trigger.service', () => ({
  helpBotTriggerService: {
    handleCreatedDrop: jest.fn().mockResolvedValue(undefined)
  }
}));
jest.mock('@/api/drops/drop-creation.api.service', () => ({
  dropCreationService: { createDrop: jest.fn() }
}));

describe('POST /drops EIP-712 integration with mocked persistence', () => {
  let server: Server;
  let baseUrl: string;
  const createdDrop = { id: 'created-submission' };

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
    jest.spyOn(dropSignatureVerifier, 'isDropSignedByAnyOfGivenWallets');
    jest.replaceProperty(process, 'env', {
      ...process.env,
      NODE_ENV: 'test',
      MAIN_STAGE_WAVE_ID: fixture.wave.id,
      ALCHEMY_API_KEY: 'test-key'
    });
    jest
      .spyOn(Date, 'now')
      .mockReturnValue(
        Date.parse(fixture.typedData.message.Verification.IssuedAt) + 60_000
      );
    clearStructuredWalletSignatureReplayCacheForTests();
    jest.mocked(getRedisClient).mockReturnValue(null);
    jest.spyOn(auth, 'getAuthenticationContext').mockResolvedValue({
      getActingAsId: () => 'author-profile',
      isAuthenticatedAsProxy: () => false,
      isUserFullyAuthenticated: () => true
    } as Awaited<ReturnType<typeof auth.getAuthenticationContext>>);
    jest.spyOn(wavesApiDb, 'findWaveById').mockResolvedValue({
      id: fixture.wave.id,
      name: fixture.wave.name,
      participation_signature_required: true,
      participation_terms: fixture.terms
    } as NonNullable<Awaited<ReturnType<typeof wavesApiDb.findWaveById>>>);
    jest
      .spyOn(identityFetcher, 'getIdentityAndConsolidationsByIdentityKey')
      .mockResolvedValue({
        wallets: [{ wallet: fixture.drop.signer_address }]
      } as NonNullable<
        Awaited<
          ReturnType<
            typeof identityFetcher.getIdentityAndConsolidationsByIdentityKey
          >
        >
      >);
    jest
      .mocked(dropCreationService.createDrop)
      .mockResolvedValue(
        createdDrop as Awaited<
          ReturnType<typeof dropCreationService.createDrop>
        >
      );
    const contract = jest.fn().mockImplementation(() => ({
      isValidSignature: jest.fn().mockResolvedValue('0xffffffff')
    }));
    jest
      .spyOn(ethers, 'Contract', 'get')
      .mockReturnValue(contract as unknown as typeof ethers.Contract);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  function signedRequest() {
    return {
      ...fixture.drop,
      signature: fixture.signature,
      signature_message: JSON.stringify(fixture.typedData)
    };
  }

  function post(
    body: unknown,
    host = 'api.6529.io',
    extraHeaders = {},
    path = '/drops'
  ): Promise<{ status: number; json: () => unknown }> {
    return new Promise((resolve, reject) => {
      const req = request(
        `${baseUrl}${path}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Host: host,
            ...extraHeaders
          }
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
              json: () => JSON.parse(responseBody) as unknown
            })
          );
        }
      );
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });
  }

  it('accepts a real typed signature through validation, authoritative context and create', async () => {
    const response = await post(signedRequest());
    expect(
      dropSignatureVerifier.isDropSignedByAnyOfGivenWallets
    ).toHaveBeenCalledWith({
      wallets: [fixture.drop.signer_address],
      drop: signedRequest(),
      termsOfService: fixture.terms,
      waveName: fixture.wave.name,
      audience: 'api.6529.io'
    });
    expect(await response.json()).toEqual(createdDrop);
    expect(response.status).toBe(200);
    expect(dropCreationService.createDrop).toHaveBeenCalledWith(
      expect.objectContaining({
        authorId: 'author-profile',
        createDropRequest: expect.objectContaining({
          title: fixture.drop.title,
          wave_id: fixture.wave.id,
          signature: fixture.signature,
          parts: expect.arrayContaining([
            expect.objectContaining({ content: fixture.drop.parts[0].content })
          ])
        })
      }),
      expect.any(Object)
    );
  });

  it('rejects a replay before a second create', async () => {
    expect((await post(signedRequest())).status).toBe(200);
    expect((await post(signedRequest())).status).toBe(400);
    expect(dropCreationService.createDrop).toHaveBeenCalledTimes(1);
  });

  it.each(['api.staging.6529.io', 'untrusted.example'])(
    'rejects a signature sent to the wrong API host %s',
    async (host) => {
      const response = await post(signedRequest(), host, {
        'X-Forwarded-Host': 'api.6529.io'
      });
      expect(response.status).toBe(400);
      expect(dropCreationService.createDrop).not.toHaveBeenCalled();
    }
  );

  it('uses a normalized API host with its standard HTTPS port', async () => {
    expect(getStructuredWalletSignatureAudienceForHost('api.6529.io:443')).toBe(
      'api.6529.io'
    );
    expect((await post(signedRequest(), 'api.6529.io:443')).status).toBe(200);
  });

  it('rejects artwork/body edits after signing', async () => {
    const response = await post({
      ...signedRequest(),
      title: 'Changed artwork'
    });
    expect(response.status).toBe(400);
    expect(dropCreationService.createDrop).not.toHaveBeenCalled();
  });

  it('rejects changes to the authoritative terms', async () => {
    jest.mocked(wavesApiDb.findWaveById).mockResolvedValue({
      id: fixture.wave.id,
      name: fixture.wave.name,
      participation_signature_required: true,
      participation_terms: `${fixture.terms}\nUpdated terms`
    } as NonNullable<Awaited<ReturnType<typeof wavesApiDb.findWaveById>>>);
    expect((await post(signedRequest())).status).toBe(400);
    expect(dropCreationService.createDrop).not.toHaveBeenCalled();
  });

  it('rejects a typed signature for chat instead of bypassing verification', async () => {
    expect(
      (await post({ ...signedRequest(), drop_type: ApiDropType.Chat })).status
    ).toBe(400);
    expect(dropCreationService.createDrop).not.toHaveBeenCalled();
  });

  it('rejects a typed signature for an unsigned non-Memes wave', async () => {
    jest.mocked(wavesApiDb.findWaveById).mockResolvedValue({
      id: 'other-wave',
      name: 'Other wave',
      participation_signature_required: false,
      participation_terms: null
    } as NonNullable<Awaited<ReturnType<typeof wavesApiDb.findWaveById>>>);
    expect(
      (await post({ ...signedRequest(), wave_id: 'other-wave' })).status
    ).toBe(400);
    expect(dropCreationService.createDrop).not.toHaveBeenCalled();
  });

  it('does not reinterpret a submission signature as permission to update an existing drop', async () => {
    const {
      wave_id: _waveId,
      drop_type: _dropType,
      ...update
    } = signedRequest();
    const response = await post(
      update,
      'api.6529.io',
      {},
      '/drops/existing-drop'
    );
    expect(response.status).toBe(400);
    expect(response.json()).toEqual({
      message: 'Meme Card submission signatures can only create new submissions'
    });
    expect(
      dropSignatureVerifier.isDropSignedByAnyOfGivenWallets
    ).not.toHaveBeenCalled();
    expect(dropCreationService.createDrop).not.toHaveBeenCalled();
  });
});
