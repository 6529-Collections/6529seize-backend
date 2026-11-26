import { CLOUDFRONT_LINK } from '@/constants';
import { aWaveDoc } from '@/tests/fixtures/waves-chain-mirror.objects.fixture';
import {
  chainWaveOf,
  checkedWaveRequest,
  EMPTY_DESCRIPTION,
  isChainOwnedWave,
  metadataChangesOf,
  parseWaveDocument,
  sameDescription,
  validMetadataOf,
  WaveDocument,
  waveHubPatchOf,
  waveIdOf,
  waveWrittenKey
} from './waves-chain-mirror.waves';

const W = `0x${'0b'.repeat(32)}`;
const G = `0x${'0a'.repeat(32)}`;
const P = `0x${'11'.repeat(32)}`;
const CID = `0x01551220${'cd'.repeat(32)}`;
const PICTURE = `${CLOUDFRONT_LINK}/waves/picture.png`;

const bytes = (doc: unknown) => Buffer.from(`${JSON.stringify(doc)}\n`);

const docOf = (fields: Record<string, unknown> = {}): WaveDocument => {
  const read = parseWaveDocument(bytes(aWaveDoc(fields)));
  if (!read.ok) throw new Error(read.reason);
  return read.doc;
};

const GROUPS = { visibility: null, chat: 'chat-group', admin: 'admin-group' };

describe('waves chain mirror waves', () => {
  it('reads a chain_waves row, and keeps the waves the chain owns', () => {
    const wave = chainWaveOf({
      wave_id: W,
      legacy_id: null,
      status: 'open',
      read_group_id: null,
      post_group_id: G,
      admin_group_id: null,
      origin: 'native',
      data: { controller: P, policyVersion: 1, metadataCid: CID }
    });
    expect(wave).toMatchObject({
      waveId: W,
      controller: P,
      policyVersion: 1,
      metadataCid: CID,
      postGroupId: G
    });
    expect(waveIdOf(wave)).toBe(W);
    expect(isChainOwnedWave(wave)).toBe(true);
    const imported = { ...wave, origin: 'legacy', legacyId: 'u-1' };
    expect(isChainOwnedWave(imported)).toBe(false);
    expect(isChainOwnedWave({ ...imported, policyVersion: 2 })).toBe(true);
    expect(isChainOwnedWave({ ...imported, status: 'closed' })).toBe(true);
    expect(waveIdOf(imported)).toBe('u-1');
    expect(waveWrittenKey({ ...wave, readGroupId: G })).not.toBe(
      waveWrittenKey(wave)
    );
    expect(
      chainWaveOf({
        wave_id: W,
        legacy_id: null,
        status: 'open',
        read_group_id: null,
        post_group_id: null,
        admin_group_id: null,
        origin: 'native',
        data: { metadataCid: '0x' }
      }).metadataCid
    ).toBeNull();
  });

  it("reads an imported wave document's description drop id as a UUID", () => {
    const UUID = '00000000-0000-4000-8000-0000000001b1';
    const read = (value: unknown) => {
      const doc = parseWaveDocument(
        bytes({ ...aWaveDoc(), description_drop_id: value })
      );
      if (!doc.ok) throw new Error(doc.reason);
      return [doc.doc.descriptionDropId, doc.doc.descriptionDropIdInvalid];
    };
    expect(read(UUID.toUpperCase())).toEqual([UUID, false]);
    expect(read(null)).toEqual([null, false]);
    expect(read('')).toEqual([null, true]);
    expect(read('not-a-uuid')).toEqual([null, true]);
    // A version digit of 0: no RFC 4122 UUID.
    expect(read('00000000-0000-0000-8000-0000000001b1')).toEqual([null, true]);
    expect(read(42)).toEqual([null, true]);
  });

  it("reads a wave document's fields, and refuses one that isn't a wave", () => {
    expect(docOf()).toEqual({
      name: 'Made on the chain',
      picture: PICTURE,
      description: [{ content: 'What this wave is about', media: [] }],
      parentWave: null,
      chat: {
        enabled: true,
        linksDisabled: false,
        repliesOpen: true,
        repliesCollapsed: false,
        slowModeCooldownMs: null
      },
      adminDropDeletionEnabled: true,
      createdAt: 1_764_000_000_000,
      metadata: { 'wave_display.rules.custom': 'Be kind' },
      descriptionDropId: null,
      descriptionDropIdInvalid: false
    });
    expect(parseWaveDocument(bytes({ ...aWaveDoc(), kind: 'group' }))).toEqual({
      ok: false,
      reason: 'wave_document_not_a_wave'
    });
    expect(parseWaveDocument(Buffer.from('{'))).toEqual({
      ok: false,
      reason: 'wave_document_not_json'
    });
    expect(parseWaveDocument(bytes(aWaveDoc({ metadata: { a: 1 } })))).toEqual({
      ok: false,
      reason: 'wave_document_invalid'
    });
  });

  it("checks a document with 6529.io's create-wave schema", () => {
    const checked = checkedWaveRequest({
      doc: docOf(),
      groups: GROUPS,
      chatEnabled: true,
      parentWaveId: null
    });
    expect(checked).toMatchObject({
      ok: true,
      dropped: [],
      request: {
        name: 'Made on the chain',
        picture: PICTURE,
        chat: { scope: { group_id: 'chat-group' }, enabled: true },
        wave: {
          type: 'CHAT',
          admin_group: { group_id: 'admin-group' },
          admin_drop_deletion_enabled: true
        }
      }
    });
  });

  it('leaves out a picture or a description the schema refuses, and holds a wave without a name', () => {
    const checked = checkedWaveRequest({
      doc: docOf({
        picture: 'https://example.com/picture.png',
        description: [{ content: 'x'.repeat(100_000), media: [] }]
      }),
      groups: GROUPS,
      chatEnabled: true,
      parentWaveId: null
    });
    expect(checked).toMatchObject({
      ok: true,
      dropped: ['description', 'picture'],
      request: { picture: null }
    });
    expect(
      checkedWaveRequest({
        doc: docOf({ name: '' }),
        groups: GROUPS,
        chatEnabled: true,
        parentWaveId: null
      })
    ).toEqual({ ok: false, reason: 'wave_document_refused' });
  });

  it("patches only the fields that moved, as 6529.io's hub edit takes them", () => {
    const before = {
      name: 'Old',
      picture: null,
      visibility_group_id: null,
      admin_group_id: 'admin-group',
      chat_group_id: null,
      chat_enabled: true,
      chat_links_disabled: false,
      chat_slow_mode_cooldown_ms: null,
      chat_replies_open: false,
      chat_replies_collapsed: false,
      admin_drop_deletion_enabled: false
    };
    expect(waveHubPatchOf(before, { ...before })).toEqual({});
    expect(
      waveHubPatchOf(before, {
        name: 'New',
        visibility_group_id: 'readers',
        chat_replies_open: true
      })
    ).toEqual({
      name: 'New',
      visibility: { scope: { group_id: 'readers' } },
      chat: { replies: { open: true, collapsed: false } }
    });
    expect(waveHubPatchOf(before, { admin_group_id: null })).toEqual({
      admin_group: { group_id: null }
    });
  });

  it('compares a description with the drop it would replace', () => {
    const parts = [
      { content: 'a', media: [{ url: 'u', mime_type: 'image/png' }] }
    ];
    expect(sameDescription(parts, [...parts])).toBe(true);
    expect(sameDescription(parts, EMPTY_DESCRIPTION)).toBe(false);
  });

  it("sets the document's metadata, and removes only keys the chain set before", () => {
    expect(
      metadataChangesOf({
        current: new Map([
          ['own', '6529.io'],
          ['rules', 'old'],
          ['gone', 'x']
        ]),
        next: { rules: 'new', added: 'y' },
        writtenBefore: ['rules', 'gone']
      })
    ).toEqual({
      upsert: [
        { key: 'rules', value: 'new' },
        { key: 'added', value: 'y' }
      ],
      remove: ['gone']
    });
    expect(validMetadataOf({ ' ok ': 'v', '': 'v', long: '' })).toEqual({
      valid: { ok: 'v' },
      dropped: 2
    });
  });
});
