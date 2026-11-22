import {
  ChainGatewayError,
  cidPath
} from '@/chain-gateway/chain-gateway.client';
import { ChainIdentity } from '@/chain-gateway/chain-gateway.types';
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
  const port = new GatewayProfileSitePort(gateway as never, profileIdOf);
  return { gateway, port, profileIdOf };
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
            profileRecord(null, null)
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
        { height: 15, time_ms: 6_000, principal: P, version: 0, doc_cid: null }
      ],
      next_height: 21
    });
    expect(gateway.getChanges).toHaveBeenCalledWith(10, {
      limit: 200,
      families: [PROFILE_FAMILY]
    });
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

  it("reads an identity at a height with the mirror's profile id", async () => {
    const { gateway, port, profileIdOf } = setup();
    gateway.getIdentityByPrincipal.mockResolvedValueOnce({
      principalId: P,
      handle: 'alice',
      wallets: [W.toUpperCase().replace('0X', '0x')],
      legacyId: LEGACY
    });
    gateway.getIdentityByPrincipal.mockResolvedValueOnce(null);
    expect(await port.getIdentityByPrincipal(P, { height: 40 })).toEqual({
      principal: P,
      profile_id: LEGACY,
      handle: 'alice',
      wallets: [W],
      imported: true
    });
    expect(gateway.getIdentityByPrincipal).toHaveBeenCalledWith(P, {
      height: 40
    });
    expect(profileIdOf).toHaveBeenCalledTimes(1);
    expect(await port.getIdentityByPrincipal(P)).toBeNull();
  });

  it('reads the import heights', async () => {
    const { gateway, port } = setup();
    gateway.getMembership.mockResolvedValueOnce({
      import: { startHeight: 5, doneHeight: 9, completed: true }
    });
    gateway.getMembership.mockResolvedValueOnce({});
    expect(await port.getIdentityImport()).toEqual({
      start_height: 5,
      done_height: 9
    });
    expect(await port.getIdentityImport()).toBeNull();
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
        new ChainGatewayError('mismatch', 200, 'cid_mismatch', '/v1/docs')
      )
      .mockRejectedValueOnce(
        new ChainGatewayError('down', 503, 'unavailable', '/v1/docs')
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
      reason: 'mismatch'
    });
    await expect(port.getProfileDoc('b1')).rejects.toMatchObject({
      code: 'unavailable'
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
