import { Wallet } from 'ethers';
import { dropHasher } from '@/api/drops/drop-hasher';
import { ApiCreateDropRequest } from '@/api/generated/models/ApiCreateDropRequest';
import {
  canonicalCompetitionJson,
  competitionPayloadHash
} from '@/competitions/competition-command-identity';
import { EntryManifest } from './waves-chain-mirror.docs';
import {
  EntryCheckContext,
  EntryCheckReads,
  ParticipationEntryChecker
} from './waves-chain-mirror.entry-checks';
import { NativeEntryContent } from './waves-chain-mirror.native-entries';

const WAVE = '00000000-0000-4000-8000-0000000000a0';
const COMPETITION = '00000000-0000-4000-8000-0000000000c0';
const TERMS = 'The terms of this wave.';
const author = new Wallet(Wallet.createRandom().privateKey);
const stranger = new Wallet(Wallet.createRandom().privateKey);

const fields = {
  wave_id: WAVE,
  drop_type: 'PARTICIPATORY',
  parts: [{ content: 'A work', media: [] }]
};

const content: NativeEntryContent = {
  title: null,
  parts: [
    { content: 'A work', quotedDropId: null, quotedDropPartId: null, media: [] }
  ],
  metadata: [],
  referencedNfts: [],
  mentionedUsers: [],
  mentionedWaves: [],
  mentionedGroups: [],
  hideLinkPreview: false,
  isAdditionalActionPromised: null,
  collaboratorIds: [],
  attachmentsLeftOut: 0
};

const context: EntryCheckContext = {
  competitionId: COMPETITION,
  waveId: WAVE,
  waveName: 'A wave',
  terms: TERMS,
  signatureRequired: true,
  mainStage: false
};

function manifest(consent: Record<string, unknown> | null): EntryManifest {
  return {
    nonce: `0x${'11'.repeat(16)}`,
    decision: `0x${'d1'.repeat(32)}`,
    wave: `0x${'a0'.repeat(32)}`,
    author: `0x${'a1'.repeat(32)}`,
    createdAt: 1,
    consent,
    fields
  };
}

function reads(overrides: Partial<EntryCheckReads> = {}): EntryCheckReads {
  return {
    walletsOfProfile: async () => [author.address],
    profileIdsByHandles: async () => new Map(),
    profileHandles: async (ids) => new Map(ids.map((id) => [id, `h-${id}`])),
    mediaUpload: async () => null,
    ...overrides
  };
}

async function dropConsent(signer: Wallet, terms: string) {
  const signerAddress = signer.address.toLowerCase();
  const hash = dropHasher.hash({
    drop: {
      ...fields,
      signer_address: signerAddress
    } as unknown as ApiCreateDropRequest,
    termsOfService: terms
  });
  return {
    scheme: '6529-drop',
    terms,
    signer_address: signerAddress,
    is_safe_signature: null,
    client_drop_id: null,
    signature_message: null,
    signature: await signer.signMessage(hash)
  };
}

async function competitionConsent(signer: Wallet, actorProfileId: string) {
  const message = canonicalCompetitionJson({
    domain: '6529-competition-v1',
    audience: 'api.example.test',
    chain_id: 1,
    action: 'ENTRY_CREATE',
    wave_id: WAVE,
    competition_id: COMPETITION,
    competition_entry_id: null,
    drop_id: null,
    config_version: 2,
    actor_profile_id: actorProfileId,
    actor_wallet: signer.address.toLowerCase(),
    payload_hash: competitionPayloadHash({
      drop: { ...fields, signature: null },
      drop_id: null
    }),
    nonce: '6f1e3d2c-1b4a-4c5d-8e9f-0a1b2c3d4e5f',
    issued_at: 1,
    expires_at: 2
  });
  return {
    scheme: '6529-competition-v1',
    terms: TERMS,
    config_version: 2,
    signer_address: signer.address.toLowerCase(),
    is_safe_signature: false,
    client_drop_id: null,
    signature_message: message,
    signature: await signer.signMessage(message)
  };
}

const check = (
  consent: Record<string, unknown> | null,
  over: Partial<EntryCheckReads> = {},
  ctx: Partial<EntryCheckContext> = {},
  c: NativeEntryContent = content
) =>
  new ParticipationEntryChecker(reads(over)).check({
    manifest: manifest(consent),
    content: c,
    authorProfileId: 'author',
    context: { ...context, ...ctx }
  });

const reason = async (...args: Parameters<typeof check>) => {
  const result = await check(...args);
  return result.ok ? 'ok' : result.reason;
};

describe('participation checks of an entry made on the chain', () => {
  it("takes a drop signature by one of the author's wallets over the wave's terms", async () => {
    expect(await reason(await dropConsent(author, TERMS))).toBe('ok');
    // Other terms, another signer, a signer not the author's: refused.
    expect(await reason(await dropConsent(author, 'other terms'))).toBe(
      'consent_invalid'
    );
    expect(await reason(await dropConsent(stranger, TERMS))).toBe(
      'consent_invalid'
    );
  });

  it("takes the decision signature 6529.io's ENTRY_CREATE signs, for the author", async () => {
    expect(await reason(await competitionConsent(author, 'author'))).toBe('ok');
    expect(await reason(await competitionConsent(author, 'someone-else'))).toBe(
      'consent_invalid'
    );
    const forged = {
      ...(await competitionConsent(author, 'author')),
      signature: await stranger.signMessage('x')
    };
    expect(await reason(forged)).toBe('consent_invalid');
  });

  it('asks for a consent only when the decision does', async () => {
    expect(await reason(null)).toBe('consent_missing');
    expect(await reason(null, {}, { signatureRequired: false })).toBe('ok');
    expect(
      await reason(
        { scheme: 'unknown', signature: '0x', signer_address: author.address },
        {},
        { signatureRequired: false }
      )
    ).toBe('consent_invalid');
  });

  it("refuses a media upload that is not the author's own of that URL and type", async () => {
    const withMedia: NativeEntryContent = {
      ...content,
      parts: [
        {
          content: null,
          quotedDropId: null,
          quotedDropPartId: null,
          media: [
            {
              url: 'https://media.example/a.png',
              mimeType: 'image/png',
              mediaUploadId: 'upload-1'
            }
          ]
        }
      ]
    };
    const upload = {
      profileId: 'author',
      publicUrl: 'https://media.example/a.png',
      declaredMimeType: 'image/png',
      status: 'ready'
    };
    const run = (u: typeof upload | null) =>
      reason(
        null,
        { mediaUpload: async () => u },
        { signatureRequired: false },
        withMedia
      );
    expect(await run(upload)).toBe('ok');
    expect(await run({ ...upload, profileId: 'someone-else' })).toBe(
      'media_upload_invalid'
    );
    expect(
      await run({ ...upload, publicUrl: 'https://media.example/b.png' })
    ).toBe('media_upload_invalid');
    expect(await run({ ...upload, status: 'failed' })).toBe(
      'media_upload_invalid'
    );
    expect(await run(null)).toBe('media_upload_invalid');
  });

  it('looks mentioned profiles up by the handles in the content, not the ids the manifest names', async () => {
    const result = await check(
      null,
      {
        profileIdsByHandles: async (handles) =>
          new Map(handles.includes('alice') ? [['Alice', 'alice-profile']] : [])
      },
      { signatureRequired: false },
      {
        ...content,
        mentionedUsers: [
          { profileId: 'not-alice', handle: 'alice' },
          { profileId: 'nobody', handle: 'ghost' }
        ]
      }
    );
    expect(result).toEqual({
      ok: true,
      content: expect.objectContaining({
        mentionedUsers: [{ profileId: 'alice-profile', handle: 'Alice' }]
      })
    });
  });

  it('keeps collaborators only on the Main Stage, distinct, not the author, each with a handle', async () => {
    const run = (ids: string[], ctx: Partial<EntryCheckContext>, over = {}) =>
      reason(
        null,
        over,
        { signatureRequired: false, ...ctx },
        {
          ...content,
          collaboratorIds: ids
        }
      );
    expect(await run(['c1'], { mainStage: true })).toBe('ok');
    expect(await run(['c1'], { mainStage: false })).toBe(
      'collaborators_outside_main_stage'
    );
    expect(await run(['author'], { mainStage: true })).toBe(
      'collaborators_invalid'
    );
    expect(
      await run(
        ['c1'],
        { mainStage: true },
        { profileHandles: async () => new Map() }
      )
    ).toBe('collaborators_invalid');
  });
});
