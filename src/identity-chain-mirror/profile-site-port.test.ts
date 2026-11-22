import {
  ChainGatewayError,
  cidPath
} from '@/chain-gateway/chain-gateway.client';
import { ChainIdentity } from '@/chain-gateway/chain-gateway.types';
import { WalletPrincipalUnknownError } from './identity-chain-lookups';
import { GatewayProfileSitePort, PROFILE_FAMILY } from './profile-site-port';

const P = '0x' + 'ab'.repeat(32);
const W = '0x' + '01'.repeat(20);
const DOC = '0x01551220' + '33'.repeat(32);
const LEGACY = '00000000-0000-4000-8000-000000000001';

function profileRecord(
  value: { version: number; docCid: string } | null,
  byImport?: boolean | null
) {
  return {
    family: PROFILE_FAMILY,
    name: 'Profile',
    key: '0x',
    value: value ? '0x01' : null,
    keyFields: { principalId: P.toUpperCase().replace('0X', '0x') },
    valueFields: value ? { ...value, updatedHeight: 10 } : null,
    ...(byImport === undefined ? {} : { byImport })
  };
}

function setup() {
  const gateway = {
    getChanges: jest.fn(),
    getMembership: jest.fn(),
    getIdentityByPrincipal: jest.fn(),
    getImportedIdentity: jest.fn(),
    getDocument: jest.fn(),
    putDocument: jest.fn()
  };
  const profileIdOf = jest.fn(async (identity: ChainIdentity) =>
    identity.legacyId ? identity.legacyId : 'derived-id'
  );
  const walletPrincipalAt = jest.fn(
    async (wallet: string, _height: number): Promise<string | null> =>
      wallet === W ? P : null
  );
  let now = 1_000;
  const port = new GatewayProfileSitePort(
    gateway as never,
    profileIdOf,
    walletPrincipalAt,
    { deadline: 5_000, now: () => now }
  );
  return {
    gateway,
    port,
    profileIdOf,
    walletPrincipalAt,
    advance: (ms: number) => {
      now += ms;
    }
  };
}

describe('GatewayProfileSitePort', () => {
  it('reads Profile writes from the feed with their block time and source', async () => {
    const { gateway, port } = setup();
    gateway.getChanges.mockResolvedValueOnce({
      from: 10,
      through: 20,
      next: 21,
      blocks: [
        {
          height: 12,
          slot: 0,
          root: '0x',
          time: 5_000,
          records: [
            profileRecord({ version: 1, docCid: DOC }, true),
            { family: '0x0102', name: 'AddressBinding', key: '0x', value: null }
          ]
        },
        {
          height: 15,
          slot: 0,
          root: '0x',
          time: 6_000,
          records: [
            profileRecord({ version: 2, docCid: DOC }, false),
            profileRecord({ version: 3, docCid: '0x' }, null),
            // Deleted (merged away) or without a version: not a change.
            profileRecord(null, null),
            profileRecord({ version: 0, docCid: DOC }, false)
          ]
        }
      ]
    });
    expect(await port.getChanges(10)).toEqual({
      changes: [
        {
          height: 12,
          time_ms: 5_000,
          principal: P,
          version: 1,
          doc_cid: cidPath(DOC),
          source: 'import'
        },
        {
          height: 15,
          time_ms: 6_000,
          principal: P,
          version: 2,
          doc_cid: cidPath(DOC),
          source: 'operation'
        },
        {
          height: 15,
          time_ms: 6_000,
          principal: P,
          version: 3,
          doc_cid: null,
          source: 'operation'
        }
      ],
      next_height: 21
    });
    expect(gateway.getChanges).toHaveBeenCalledWith(10, {
      limit: 200,
      families: [PROFILE_FAMILY]
    });
  });

  it('settles the source in the block that completed the import', async () => {
    const { gateway, port } = setup();
    const OTHER = '0x01551220' + '44'.repeat(32);
    gateway.getChanges.mockResolvedValueOnce({
      from: 10,
      through: 10,
      next: 11,
      blocks: [
        {
          height: 10,
          slot: 0,
          root: '0x',
          time: 1,
          records: [profileRecord({ version: 1, docCid: DOC }, null)]
        }
      ]
    });
    gateway.getChanges.mockResolvedValueOnce({
      from: 10,
      through: 10,
      next: 11,
      blocks: [
        {
          height: 10,
          slot: 0,
          root: '0x',
          time: 1,
          records: [profileRecord({ version: 2, docCid: OTHER }, null)]
        }
      ]
    });
    gateway.getImportedIdentity.mockResolvedValue({
      principalId: P,
      profileDocCid: DOC
    });
    expect((await port.getChanges(10)).changes[0].source).toBe('import');
    expect((await port.getChanges(10)).changes[0].source).toBe('operation');
    // A later version with the import's document is still an operation.
    gateway.getChanges.mockResolvedValueOnce({
      from: 10,
      through: 10,
      next: 11,
      blocks: [
        {
          height: 10,
          slot: 0,
          root: '0x',
          time: 1,
          records: [profileRecord({ version: 2, docCid: DOC }, null)]
        }
      ]
    });
    expect((await port.getChanges(10)).changes[0].source).toBe('operation');
  });

  it('ends at the finalized head', async () => {
    const { gateway, port } = setup();
    gateway.getChanges.mockResolvedValueOnce({
      from: 30,
      through: 29,
      next: 30,
      blocks: []
    });
    expect(await port.getChanges(30)).toEqual({
      changes: [],
      next_height: null
    });
  });

  const W2 = '0x' + '02'.repeat(20);
  const now = {
    principalId: P,
    handle: 'alice',
    wallets: [W.toUpperCase().replace('0X', '0x'), W2],
    legacyId: LEGACY
  };

  it("reads an identity at a height with the mirror's profile id now", async () => {
    const { gateway, port, profileIdOf } = setup();
    gateway.getIdentityByPrincipal
      .mockResolvedValueOnce(now)
      .mockResolvedValueOnce({ ...now, handle: 'old', wallets: [W] })
      .mockResolvedValueOnce(null);
    expect(await port.getIdentityByPrincipal(P, { height: 40 })).toEqual({
      principal: P,
      profile_id: LEGACY,
      handle: 'old',
      wallets: [W],
      imported: true
    });
    expect(gateway.getIdentityByPrincipal).toHaveBeenNthCalledWith(1, P);
    expect(gateway.getIdentityByPrincipal).toHaveBeenNthCalledWith(2, P, {
      height: 40
    });
    expect(profileIdOf).toHaveBeenCalledWith(now);
    expect(await port.getIdentityByPrincipal(P)).toBeNull();
  });

  it('leaves out a wallet bound to another identity then, and says when one was not imported', async () => {
    const { gateway, port, walletPrincipalAt } = setup();
    gateway.getIdentityByPrincipal
      .mockResolvedValueOnce({ ...now, legacyId: null })
      .mockRejectedValueOnce(
        new ChainGatewayError('gone', 409, 'height_gone', '/v1/identities')
      );
    walletPrincipalAt.mockImplementation(async (wallet: string) =>
      wallet === W ? P : '0x' + 'cd'.repeat(32)
    );
    const identity = await port.getIdentityByPrincipal(P, { height: 7 });
    expect(identity?.wallets).toEqual([W]);
    expect(identity?.imported).toBe(false);
  });

  it('lists the wallets bound then when the gateway no longer holds the height', async () => {
    const { gateway, port, walletPrincipalAt } = setup();
    gateway.getIdentityByPrincipal
      .mockResolvedValueOnce(now)
      .mockRejectedValueOnce(
        new ChainGatewayError('gone', 409, 'height_gone', '/v1/identities')
      );
    expect(await port.getIdentityByPrincipal(P, { height: 7 })).toEqual({
      principal: P,
      profile_id: LEGACY,
      handle: 'alice',
      wallets: [W],
      imported: true
    });
    expect(walletPrincipalAt).toHaveBeenCalledWith(W2, 7);
  });

  it("throws when a wallet's principal then is unknown, so the change is tried again", async () => {
    const { gateway, port, walletPrincipalAt } = setup();
    gateway.getIdentityByPrincipal
      .mockResolvedValueOnce(now)
      .mockRejectedValueOnce(
        new ChainGatewayError('gone', 409, 'height_gone', '/v1/identities')
      );
    walletPrincipalAt.mockRejectedValueOnce(
      new WalletPrincipalUnknownError(W, 7)
    );
    await expect(
      port.getIdentityByPrincipal(P, { height: 7 })
    ).rejects.toBeInstanceOf(WalletPrincipalUnknownError);
  });

  it('ends the pass at its deadline, and halves a page too large', async () => {
    const { gateway, port, advance } = setup();
    gateway.getMembership.mockResolvedValue({});
    gateway.getChanges
      .mockRejectedValueOnce(
        new ChainGatewayError('too large', 413, 'too_large', '/v1/feed')
      )
      .mockResolvedValueOnce({ from: 1, through: 0, next: 1, blocks: [] });
    await port.getChanges(1);
    expect(gateway.getChanges).toHaveBeenNthCalledWith(2, 1, {
      limit: 100,
      families: [PROFILE_FAMILY]
    });
    advance(10_000);
    expect(await port.getChanges(1)).toEqual({
      changes: [],
      next_height: null
    });
    expect(gateway.getChanges).toHaveBeenCalledTimes(2);
  });

  it('does not keep the import heights while the import runs', async () => {
    const { gateway, port } = setup();
    gateway.getMembership
      .mockResolvedValueOnce({
        import: { startHeight: 5, doneHeight: null, count: 3 }
      })
      .mockResolvedValueOnce({
        import: { startHeight: 5, doneHeight: 9, count: 3 }
      });
    expect(await port.getIdentityImport()).toEqual({
      start_height: 5,
      done_height: null
    });
    expect(await port.getIdentityImport()).toEqual({
      start_height: 5,
      done_height: 9
    });
  });

  it.each([
    [
      'the heights of a done import',
      { startHeight: 5, doneHeight: 9, count: 3 },
      { start_height: 5, done_height: 9 }
    ],
    // The feed starts after the import's first block: every Profile write
    // up to the done height is the import's.
    [
      'a start the gateway does not hold as 0',
      { startHeight: null, doneHeight: 9, count: 3 },
      { start_height: 0, done_height: 9 }
    ],
    ['no import as null', { count: 0 }, null],
    ['no record as null', undefined, null]
  ])('reads %s', async (_name, record, expected) => {
    const { gateway, port } = setup();
    gateway.getMembership.mockResolvedValue({ import: record });
    expect(await port.getIdentityImport()).toEqual(expected);
  });

  it('keeps a done import and reads from its start', async () => {
    const { gateway, port } = setup();
    gateway.getMembership.mockResolvedValue({
      import: { startHeight: 5, doneHeight: 9, count: 3 }
    });
    gateway.getChanges.mockResolvedValue({
      from: 5,
      through: 4,
      next: 5,
      blocks: []
    });
    await port.getChanges(0);
    await port.getChanges(7);
    expect(gateway.getChanges).toHaveBeenNthCalledWith(1, 5, {
      limit: 200,
      families: [PROFILE_FAMILY]
    });
    expect(gateway.getChanges).toHaveBeenNthCalledWith(2, 7, {
      limit: 200,
      families: [PROFILE_FAMILY]
    });
    expect(gateway.getMembership).toHaveBeenCalledTimes(1);
  });

  it('reads a document as found, missing or malformed', async () => {
    const { gateway, port } = setup();
    gateway.getDocument
      .mockResolvedValueOnce(
        Buffer.from(JSON.stringify({ fields: { 'cms.archive': 'x' } }))
      )
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(Buffer.from('not a document'))
      .mockRejectedValueOnce(
        new ChainGatewayError('not a CID', null, 'bad_request', '/v1/docs')
      )
      .mockRejectedValueOnce(
        new ChainGatewayError('mismatch', 200, 'cid_mismatch', '/v1/docs')
      );
    expect(await port.getProfileDoc('b1')).toEqual({
      status: 'found',
      fields: { 'cms.archive': 'x' }
    });
    expect(await port.getProfileDoc('b1')).toEqual({ status: 'missing' });
    expect(await port.getProfileDoc('b1')).toMatchObject({
      status: 'malformed'
    });
    expect(await port.getProfileDoc('b1')).toEqual({
      status: 'malformed',
      reason: 'not a CID'
    });
    // Wrong bytes from the store: tried again, never applied as broken.
    await expect(port.getProfileDoc('b1')).rejects.toMatchObject({
      code: 'cid_mismatch'
    });
  });

  it("names the import's document as base32 text", async () => {
    const { gateway, port } = setup();
    gateway.getImportedIdentity
      .mockResolvedValueOnce({ principalId: P, profileDocCid: DOC })
      .mockResolvedValueOnce({ principalId: P, profileDocCid: null })
      .mockResolvedValueOnce(null);
    expect(await port.getImportedProfileDocCid(P)).toBe(cidPath(DOC));
    expect(await port.getImportedProfileDocCid(P)).toBeNull();
    expect(await port.getImportedProfileDocCid(P)).toBeNull();
  });

  it('reads and stores files through the document store', async () => {
    const { gateway, port } = setup();
    const bytes = Buffer.from('file');
    gateway.getDocument.mockResolvedValueOnce(bytes);
    gateway.putDocument.mockResolvedValueOnce('bafkreiexample');
    expect(await port.getDocBytes('bafkreiexample')).toBe(bytes);
    expect(await port.putDocBytes(bytes)).toBe('bafkreiexample');
    expect(gateway.putDocument).toHaveBeenCalledWith(bytes);
  });
});
