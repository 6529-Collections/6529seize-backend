import { Server } from 'node:http';

const mockSearchDraftWaveMentions = jest.fn();
const mockSearchWaveMentions = jest.fn();

jest.mock('@/api/auth/auth', () => ({
  maybeAuthenticatedUser: () => (_req: any, _res: any, next: any) => next(),
  needsAuthenticatedUser: () => (_req: any, _res: any, next: any) => next()
}));

jest.mock('@/api/waves/wave-mention-search.handler', () => ({
  handleSearchDraftWaveMentions: mockSearchDraftWaveMentions,
  handleSearchWaveMentions: mockSearchWaveMentions
}));

import generatedOpenApiRoutes from '@/api/generated/routes/openapi-generated.routes';

const express = require('express');

describe('wave mention search generated routes', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    mockSearchDraftWaveMentions.mockResolvedValue([]);
    const app = express();
    app.use(generatedOpenApiRoutes);
    server = await new Promise<Server>((resolve) => {
      const listeningServer = app.listen(0, () => resolve(listeningServer));
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected an ephemeral TCP address');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it('dispatches the static draft path to the draft handler', async () => {
    const response = await fetch(
      `${baseUrl}/v2/waves/mention-search?handle=ali`
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([]);
    expect(mockSearchDraftWaveMentions).toHaveBeenCalledTimes(1);
    expect(mockSearchWaveMentions).not.toHaveBeenCalled();
  });
});
