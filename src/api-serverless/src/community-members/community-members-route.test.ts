import { Server } from 'node:http';

const mockSearchCommunityMemberMinimalsOfClosestMatches = jest.fn();

jest.mock('../auth/auth', () => ({
  getAuthenticationContext: jest.fn(),
  maybeAuthenticatedUser:
    () => (_req: unknown, _res: unknown, next: () => void) =>
      next()
}));

jest.mock('../identities/identity.fetcher', () => ({
  identityFetcher: {
    searchCommunityMemberMinimalsOfClosestMatches:
      mockSearchCommunityMemberMinimalsOfClosestMatches
  }
}));

jest.mock('./community-members.service', () => ({
  communityMembersService: {
    getCommunityMembersPage: jest.fn()
  }
}));

import communityMembersRoutes from './community-members.routes';

const express = require('express');

describe('community member minimal search route', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    mockSearchCommunityMemberMinimalsOfClosestMatches.mockResolvedValue([]);
    const app = express();
    app.use('/community-members', communityMembersRoutes);
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

  beforeEach(() => {
    mockSearchCommunityMemberMinimalsOfClosestMatches.mockClear();
  });

  it('opts into raw-level ordering when requested', async () => {
    const response = await fetch(
      `${baseUrl}/community-members?param=gel&only_profile_owners=true&sort=level`
    );

    expect(response.status).toBe(200);
    expect(
      mockSearchCommunityMemberMinimalsOfClosestMatches
    ).toHaveBeenCalledWith({
      param: 'gel',
      onlyProfileOwners: true,
      limit: 10,
      sort: 'level'
    });
  });

  it('preserves default relevance ordering when no sort is supplied', async () => {
    const response = await fetch(
      `${baseUrl}/community-members?param=gel&only_profile_owners=true`
    );

    expect(response.status).toBe(200);
    expect(
      mockSearchCommunityMemberMinimalsOfClosestMatches
    ).toHaveBeenCalledWith({
      param: 'gel',
      onlyProfileOwners: true,
      limit: 10,
      sort: undefined
    });
  });

  it('rejects an unsupported sort value', async () => {
    const response = await fetch(
      `${baseUrl}/community-members?param=gel&only_profile_owners=true&sort=unknown`
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Unsupported community-member sort'
    });
    expect(
      mockSearchCommunityMemberMinimalsOfClosestMatches
    ).not.toHaveBeenCalled();
  });
});
