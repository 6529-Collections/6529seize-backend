import express, { NextFunction, Request, Response } from 'express';
import { Server } from 'node:http';
import { ApiCompliantException } from '@/exceptions';
import { abusivenessCheckDb } from '@/profiles/abusiveness-check.db';
import { abusivenessCheckService } from '@/profiles/abusiveness-check.service';
import router from './rep-category-search.routes';

async function getCategories(
  path: string
): Promise<{ status: number; body: unknown }> {
  const app = express();
  app.use('/rep/categories', router);
  app.use(
    (
      error: ApiCompliantException,
      _req: Request,
      res: Response,
      _next: NextFunction
    ) => {
      res.status(error.getStatusCode?.() ?? 500).send({ error: error.message });
    }
  );
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing test address');
    const response = await fetch(
      `http://127.0.0.1:${address.port}/rep/categories${path}`
    );
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
}

describe('rep category search routes', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns the stored categories unchanged for a search that matches Help6529 Credits', async () => {
    const search = jest
      .spyOn(abusivenessCheckDb, 'searchAllowedTextsLike')
      .mockResolvedValue(['Art']);

    expect(await getCategories('/?param=help6529')).toEqual({
      status: 200,
      body: ['Art']
    });
    expect(search).toHaveBeenCalledWith({ text: 'help6529', limit: 10 });
  });

  it('checks Help6529 Credits for availability like any other phrase', async () => {
    const probe = jest
      .spyOn(abusivenessCheckService, 'probeRepPhrase')
      .mockResolvedValue({
        status: 'ALLOWED',
        explanation: null,
        text: 'Help6529 Credits',
        external_check_performed_at: new Date(0)
      });

    expect(
      await getCategories('/availability?param=Help6529%20Credits')
    ).toEqual({ status: 200, body: true });
    expect(probe).toHaveBeenCalledWith('Help6529 Credits');
  });

  it('rejects the phrase only when the abusiveness check disallows it', async () => {
    jest.spyOn(abusivenessCheckService, 'probeRepPhrase').mockResolvedValue({
      status: 'DISALLOWED',
      explanation: 'Rejected',
      text: 'Help6529 Credits',
      external_check_performed_at: new Date(0)
    });

    expect(
      await getCategories('/availability?param=Help6529%20Credits')
    ).toEqual({ status: 400, body: { error: 'Rejected' } });
  });
});
