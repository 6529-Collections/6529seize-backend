import { ethers } from 'ethers';
import { SiweMessage } from 'siwe';
import {
  buildMlsDeviceGrantUrn,
  isCombinedGrantPair,
  isCombinedGrantStatement,
  MlsDeviceGrantTerms,
  parseMlsDeviceGrantUrn,
  renderCombinedGrantStatement
} from './combined-device-grant';
import {
  computeDeviceGrantId,
  DeviceGrantTerms,
  renderDeviceGrantStatement
} from './device-grant-message';

// Shared NC8 combined-grant vectors. The frontend pins the same values in
// __tests__/lib/device-signing/combined-grant-vectors.ts; keep them identical.
const SIGNING_KEY =
  '0xd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
// RFC 8032 test 2 public key, standing in for an MLS signature key.
const MLS_KEY =
  '0x3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c';
const EXPIRES_AT = 1807876800;
const SIGNING_URN =
  'urn:6529:device-grant:v1:ed25519:d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a:post.edit.delete.react:1807876800';
const MLS_URN =
  'urn:6529:mls-device-grant:v1:1:3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c:1807876800';
const COMBINED_STATEMENT =
  "Sign in to 6529 and turn on signed messages on this device until 16 Apr 2027. This device will sign your posts, edits, deletes and reactions so anyone can verify they came from your wallet. It will also send and read your end-to-end encrypted messages, which 6529 cannot read. It can't move funds, change your handle, add devices or act as an admin. No transaction, no gas, no token approvals. (Device key d75a9801...f707511a, encrypted messages key 3d4017c3...2af4660c)";
// EIP-191 hash of COMBINED_MESSAGE: the grant id and MLS credential grant id.
const COMBINED_GRANT_ID =
  '0x6aee792a1bc44547ed42fba60b21c58c9c2f06a12c5278b950d3272642fd97ea';
const COMBINED_MESSAGE = [
  'https://staging.6529.io wants you to sign in with your Ethereum account:',
  '0x1111111111111111111111111111111111111111',
  '',
  COMBINED_STATEMENT,
  '',
  'URI: https://staging.6529.io',
  'Version: 1',
  'Chain ID: 1',
  'Nonce: a1b2c3d4e5f60718293a4b5c6d7e8f90',
  'Issued At: 2026-10-18T12:00:00.000Z',
  'Expiration Time: 2026-10-18T12:05:00.000Z',
  'Resources:',
  `- ${SIGNING_URN}`,
  `- ${MLS_URN}`
].join('\n');

const SIGNING: DeviceGrantTerms = {
  keyType: 'ed25519',
  deviceKey: SIGNING_KEY,
  scopes: ['post', 'edit', 'delete', 'react'],
  expiresAtSeconds: EXPIRES_AT
};
const MLS: MlsDeviceGrantTerms = {
  deviceKey: MLS_KEY,
  ciphersuite: 1,
  expiresAtSeconds: EXPIRES_AT
};

describe('combined device grant', () => {
  describe('shared vectors', () => {
    it('builds and parses the MLS resource', () => {
      expect(buildMlsDeviceGrantUrn(MLS)).toBe(MLS_URN);
      expect(parseMlsDeviceGrantUrn(MLS_URN)).toEqual(MLS);
    });

    it('renders the combined statement', () => {
      expect(renderCombinedGrantStatement(SIGNING, MLS)).toBe(
        COMBINED_STATEMENT
      );
    });

    it('is a well-formed SIWE message with the vector grant id', () => {
      const parsed = new SiweMessage(COMBINED_MESSAGE);
      expect(parsed.prepareMessage()).toBe(COMBINED_MESSAGE);
      expect(parsed.statement).toBe(COMBINED_STATEMENT);
      expect(parsed.resources).toEqual([SIGNING_URN, MLS_URN]);
      expect(computeDeviceGrantId(COMBINED_MESSAGE)).toBe(COMBINED_GRANT_ID);
      expect(ethers.hashMessage(COMBINED_MESSAGE)).toBe(COMBINED_GRANT_ID);
    });

    it('keeps the approved signed-messages wording around one added clause', () => {
      const signingOnly = renderDeviceGrantStatement(SIGNING);
      const clause =
        ' It will also send and read your end-to-end encrypted messages, which 6529 cannot read.';
      expect(
        COMBINED_STATEMENT.replace(clause, '').replace(
          ', encrypted messages key 3d4017c3...2af4660c)',
          ')'
        )
      ).toBe(signingOnly);
    });
  });

  describe('MLS resource', () => {
    it.each([
      ['a 0x prefix', MLS_URN.replace(':1:3d40', ':1:0x3d40')],
      ['an uppercase key', MLS_URN.toUpperCase()],
      ['a short key', MLS_URN.replace('3d4017c3', '3d4017')],
      ['ciphersuite 0', MLS_URN.replace(':v1:1:', ':v1:0:')],
      ['a padded ciphersuite', MLS_URN.replace(':v1:1:', ':v1:01:')],
      ['a ciphersuite above uint16', MLS_URN.replace(':v1:1:', ':v1:65536:')],
      ['an unaligned expiry', MLS_URN.replace(':1807876800', ':1807876801')],
      ['another version', MLS_URN.replace(':v1:', ':v2:')],
      ['a signing URN', SIGNING_URN],
      ['a trailing field', `${MLS_URN}:x`]
    ])('rejects %s', (_name, urn) => {
      expect(parseMlsDeviceGrantUrn(urn)).toBeNull();
    });

    it('accepts the hybrid post-quantum ciphersuite 0x004F', () => {
      const urn = buildMlsDeviceGrantUrn({ ...MLS, ciphersuite: 0x004f });
      expect(urn).toContain(':v1:79:');
      expect(parseMlsDeviceGrantUrn(urn)?.ciphersuite).toBe(0x004f);
    });

    it('rejects non-strings', () => {
      expect(parseMlsDeviceGrantUrn(undefined)).toBeNull();
      expect(parseMlsDeviceGrantUrn(42)).toBeNull();
    });
  });

  describe('pairing and statement', () => {
    it('requires one expiry and two different keys', () => {
      expect(isCombinedGrantPair(SIGNING, MLS)).toBe(true);
      expect(
        isCombinedGrantPair(SIGNING, {
          ...MLS,
          expiresAtSeconds: EXPIRES_AT + 60
        })
      ).toBe(false);
      expect(
        isCombinedGrantPair(SIGNING, { ...MLS, deviceKey: SIGNING_KEY })
      ).toBe(false);
    });

    it.each([
      ['the signing statement alone', renderDeviceGrantStatement(SIGNING)],
      ['an edited clause', COMBINED_STATEMENT.replace('cannot read', 'reads')],
      ['another MLS key', COMBINED_STATEMENT.replace('3d4017c3', '3d4017c4')],
      ['another expiry date', COMBINED_STATEMENT.replace('16 Apr', '17 Apr')],
      ['no statement', undefined]
    ])('rejects %s', (_name, statement) => {
      expect(isCombinedGrantStatement(statement, SIGNING, MLS)).toBe(false);
    });

    it('accepts exactly the rendered statement', () => {
      expect(isCombinedGrantStatement(COMBINED_STATEMENT, SIGNING, MLS)).toBe(
        true
      );
    });
  });
});
