import express, { NextFunction, Request, Response } from 'express';
import * as mcache from 'memory-cache';
import { AddressInfo } from 'node:net';
import { ChainGatewayClient } from '@/chain-gateway/chain-gateway.client';
import { identitiesDb } from '@/identities/identities.db';
import { identityReadsShadow } from '@/identity-chain-mirror/identity-reads-shadow';
import { LazyDbAccessCompatibleService } from '@/sql-executor';

jest.mock('@/api/auth/auth', () => ({
  ...jest.requireActual('@/api/auth/auth'),
  maybeAuthenticatedUser:
    () => (_req: Request, _res: Response, next: NextFunction) =>
      next(),
  // Other routes of the router mount it; availability doesn't use it.
  needsAuthenticatedUser:
    () => (_req: Request, _res: Response, next: NextFunction) =>
      next()
}));

import { getAuthenticationContext } from '@/api/auth/auth';
import { identityFetcher } from './identity.fetcher';
import profilesRouter from '../profiles/profiles.routes';

const WALLET = '0x00000000000000000000000000000000000000e5';
const PROFILE_ID = '00000000-0000-4000-8000-0000000000e5';

/**
 * With FEATURE_IDENTITY_READS_FROM_CHAIN off, the lookups the chain reads
 * would take over (fetcher, login, handle availability) make no gateway
 * call (any client, any method) and no database read but the
 * identities-table read each made before; the shadow counter only notes
 * them in memory.
 */
describe('identity lookups with the flag off', () => {
  const gatewayCalls: string[] = [];
  let dbAccesses = 0;
  const reads = {
    getIdentityByWallet: jest.spyOn(identitiesDb, 'getIdentityByWallet'),
    getIdentityByHandle: jest.spyOn(identitiesDb, 'getIdentityByHandle'),
    getIdentityByProfileId: jest.spyOn(identitiesDb, 'getIdentityByProfileId'),
    getProfileIdByWallet: jest.spyOn(identitiesDb, 'getProfileIdByWallet')
  };
  const note = jest.spyOn(identityReadsShadow, 'note');

  beforeAll(() => {
    // Every method of every gateway client, private ones included.
    for (const name of Object.getOwnPropertyNames(
      ChainGatewayClient.prototype
    )) {
      const descriptor = Object.getOwnPropertyDescriptor(
        ChainGatewayClient.prototype,
        name
      );
      if (name === 'constructor' || typeof descriptor?.value !== 'function') {
        continue;
      }
      jest
        .spyOn(ChainGatewayClient.prototype as any, name)
        .mockImplementation(() => {
          gatewayCalls.push(name);
          throw new Error(`gateway ${name} called`);
        });
    }
    // Any database access of any service (identity mirror's included).
    jest
      .spyOn(LazyDbAccessCompatibleService.prototype as any, 'db', 'get')
      .mockImplementation(() => {
        dbAccesses++;
        throw new Error('database read');
      });
  });

  beforeEach(() => {
    delete process.env.FEATURE_IDENTITY_READS_FROM_CHAIN;
    mcache.clear();
    gatewayCalls.length = 0;
    dbAccesses = 0;
    note.mockClear();
    reads.getIdentityByWallet.mockReset().mockResolvedValue(null);
    reads.getIdentityByHandle.mockReset().mockResolvedValue(null);
    reads.getIdentityByProfileId.mockReset().mockResolvedValue(null);
    reads.getProfileIdByWallet.mockReset().mockResolvedValue(null);
  });

  afterAll(() => jest.restoreAllMocks());

  function nothingElse() {
    expect(gatewayCalls).toEqual([]);
    expect(dbAccesses).toBe(0);
  }

  it('the fetcher reads one identities row a lookup', async () => {
    await expect(
      identityFetcher.getIdentityAndConsolidationsByIdentityKey(
        { identityKey: WALLET },
        {}
      )
    ).resolves.toMatchObject({ id: null, primary_wallet: WALLET });
    await expect(
      identityFetcher.getIdentityAndConsolidationsByIdentityKey(
        { identityKey: 'alice' },
        {}
      )
    ).resolves.toBeNull();
    await expect(
      identityFetcher.getIdentityAndConsolidationsByIdentityKey(
        { identityKey: PROFILE_ID },
        {}
      )
    ).resolves.toBeNull();
    expect(reads.getIdentityByWallet).toHaveBeenCalledTimes(1);
    expect(reads.getIdentityByWallet).toHaveBeenCalledWith(WALLET, undefined);
    expect(reads.getIdentityByHandle).toHaveBeenCalledTimes(1);
    expect(reads.getIdentityByHandle).toHaveBeenCalledWith('alice', {});
    expect(reads.getIdentityByProfileId).toHaveBeenCalledTimes(1);
    expect(reads.getIdentityByProfileId).toHaveBeenCalledWith(
      PROFILE_ID,
      undefined
    );
    expect(note.mock.calls).toEqual([
      ['by_wallet', WALLET],
      ['by_handle', 'alice'],
      ['by_profile_id', PROFILE_ID]
    ]);
    nothingElse();
  });

  it('login reads the profile id of the wallet, as before', async () => {
    const context = await getAuthenticationContext({
      user: { wallet: WALLET, role: null }
    } as any);
    expect(context.getActingAsId()).toBeNull();
    expect(reads.getProfileIdByWallet).toHaveBeenCalledTimes(1);
    expect(reads.getProfileIdByWallet.mock.calls[0][0]).toBe(WALLET);
    expect(note.mock.calls).toEqual([['login', WALLET]]);
    nothingElse();
  });

  it('handle availability reads the handle in the identities table, as before', async () => {
    const app = express();
    app.use('/profiles', profilesRouter);
    const server = await new Promise<ReturnType<typeof app.listen>>(
      (resolve) => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
      }
    );
    try {
      const port = (server.address() as AddressInfo).port;
      const response = await fetch(
        `http://127.0.0.1:${port}/profiles/freename/availability`
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        available: true,
        message: 'Username is available.'
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(reads.getIdentityByHandle).toHaveBeenCalledTimes(1);
    expect(reads.getIdentityByHandle.mock.calls[0][0]).toBe('freename');
    expect(note.mock.calls).toEqual([
      ['availability', 'freename'],
      ['by_handle', 'freename']
    ]);
    nothingElse();
  });
});
