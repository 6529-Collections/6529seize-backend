import {
  aBoardRow,
  aChainDecision,
  aChainDecisionState,
  aChainEntry,
  aChainVote,
  aCompetition,
  applyWritesInMemory,
  aTargetEntry,
  aTargetState,
  chainId,
  someLookups,
  uuid
} from '@/tests/fixtures/waves-chain-mirror.fixture';
import { nativeEntryRowId } from './waves-chain-mirror.ids';
import {
  NativeEntryLookup,
  nativeEntryContent,
  ParticipationRules,
  participationRulesOf
} from './waves-chain-mirror.native-entries';
import { planDecision, planWrites } from './waves-chain-mirror.plan';
import { EntryManifest } from './waves-chain-mirror.docs';

const D = chainId('d1');
const C = uuid(1);
const WAVE = uuid(900);
const E1 = chainId('e1');
const EN = chainId('e9');
const AUTHOR = chainId('a9');
const V1 = chainId('b1');
const DROP1 = uuid(11);
const ROW_1 = uuid(21);
const NOW = 1_765_000_000_000;

const fields = {
  wave_id: WAVE,
  drop_type: 'PARTICIPATORY',
  title: 'An entry',
  parts: [
    {
      content: 'hello',
      media: [{ url: 'https://media.example/a.png', mime_type: 'image/png' }]
    }
  ],
  metadata: [{ data_key: 'title', data_value: 'A card' }],
  referenced_nfts: [],
  mentioned_users: [],
  mentioned_waves: []
};

const manifest = (f: Record<string, unknown> = fields): EntryManifest => ({
  nonce: `0x${'5a'.repeat(16)}`,
  decision: D,
  wave: chainId('a0'),
  author: AUTHOR,
  createdAt: 1,
  consent: null,
  fields: f
});

describe('native entries: content', () => {
  it("takes a manifest's entry as 6529.io's create path validates it", () => {
    const found = nativeEntryContent(manifest(), { waveId: WAVE });
    expect(found).toEqual({
      ok: true,
      content: {
        title: 'An entry',
        parts: [
          {
            content: 'hello',
            quotedDropId: null,
            quotedDropPartId: null,
            media: [
              {
                url: 'https://media.example/a.png',
                mimeType: 'image/png',
                mediaUploadId: null
              }
            ]
          }
        ],
        metadata: [{ dataKey: 'title', dataValue: 'A card' }],
        referencedNfts: [],
        mentionedUsers: [],
        mentionedWaves: [],
        mentionedGroups: [],
        hideLinkPreview: false,
        isAdditionalActionPromised: null,
        collaboratorIds: [],
        attachmentsLeftOut: 0
      }
    });
  });

  it('holds back content that would not pass, saying why', () => {
    const reason = (f: Record<string, unknown>) => {
      const found = nativeEntryContent(manifest(f), { waveId: WAVE });
      return found.ok ? 'ok' : found.reason;
    };
    expect(reason({ ...fields, wave_id: uuid(901) })).toBe('wave_mismatch');
    expect(reason({ ...fields, parts: [] })).toBe('invalid_content');
    expect(reason({ ...fields, title: 'x'.repeat(251) })).toBe(
      'invalid_content'
    );
    expect(reason({ ...fields, unknown_field: 1 })).toBe('invalid_content');
    expect(reason({ ...fields, parts: [{ content: ' ', media: [] }] })).toBe(
      'empty_part'
    );
    expect(
      reason({ ...fields, poll: { options: ['a', 'b'], multichoice: false } })
    ).toBe('poll_in_entry');
    const withAttachment = nativeEntryContent(
      manifest({
        ...fields,
        parts: [
          { content: 'a', media: [], attachments: [{ attachment_id: 'x' }] }
        ]
      }),
      { waveId: WAVE }
    );
    expect(withAttachment.ok && withAttachment.content.attachmentsLeftOut).toBe(
      1
    );
  });
});

describe('native entries: the decision entry rules', () => {
  const reason = (
    f: Record<string, unknown>,
    rules: Partial<ParticipationRules> = {}
  ) => {
    const found = nativeEntryContent(manifest(f), {
      waveId: WAVE,
      rules: {
        requiredMetadata: [],
        requiredMedia: [],
        anonymous: false,
        ...rules
      }
    });
    return found.ok ? 'ok' : found.reason;
  };

  it('refuses quotes and replies, and a part left with neither content nor media', () => {
    expect(
      reason({
        ...fields,
        parts: [
          {
            content: 'q',
            media: [],
            quoted_drop: { drop_id: 'x', drop_part_id: 1 }
          }
        ]
      })
    ).toBe('quote_or_reply_in_entry');
    expect(
      reason({ ...fields, reply_to: { drop_id: 'x', drop_part_id: 1 } })
    ).toBe('quote_or_reply_in_entry');
    expect(
      reason({
        ...fields,
        parts: [
          { content: 'a', media: [] },
          { content: null, media: [], attachments: [{ attachment_id: 'a1' }] }
        ]
      })
    ).toBe('empty_part');
  });

  it("asks for the decision's required metadata and media", () => {
    const metadata = (value: string) => ({
      ...fields,
      metadata: [{ data_key: 'edition', data_value: value }]
    });
    const edition = [{ name: 'edition', type: 'NUMBER' }];
    expect(reason(metadata('12'), { requiredMetadata: edition })).toBe('ok');
    expect(reason(metadata('twelve'), { requiredMetadata: edition })).toBe(
      'required_metadata'
    );
    expect(reason(fields, { requiredMetadata: edition })).toBe(
      'required_metadata'
    );
    expect(reason(fields, { requiredMedia: ['IMAGE'] })).toBe('ok');
    expect(reason(fields, { requiredMedia: ['VIDEO'] })).toBe('required_media');
    expect(
      participationRulesOf({
        required_metadata: [{ name: 'edition', type: 'NUMBER' }],
        required_media: ['IMAGE'],
        anonymous_submissions: true
      })
    ).toEqual({
      requiredMetadata: edition,
      requiredMedia: ['IMAGE'],
      anonymous: true
    });
  });
});

describe('native entries: plan', () => {
  const chain = aChainDecisionState(
    aChainDecision({ decisionId: D, legacyId: C, data: { configVersion: 3 } }),
    {
      entries: [
        aChainEntry({
          entryId: E1,
          decisionId: D,
          legacyId: DROP1,
          total: '5'
        }),
        aChainEntry({
          entryId: EN,
          decisionId: D,
          legacyId: null,
          origin: 'native',
          author: AUTHOR,
          total: '9',
          data: { createdMs: 1_764_500_000_000, lastIncrease: { time: 0 } }
        })
      ],
      votes: [aChainVote(EN, V1, 9)],
      board: [aBoardRow(EN, 1, 9, 9), aBoardRow(E1, 2, 5, 5)]
    }
  );
  const target = aTargetState(aCompetition({ id: C, waveId: WAVE }), {
    entries: [aTargetEntry({ id: ROW_1, dropId: DROP1 })]
  });
  const content = nativeEntryContent(manifest(), { waveId: WAVE });
  const lookups = (
    found: NativeEntryLookup | null = content,
    profiles: Record<string, string> = { [AUTHOR]: 'author', [V1]: 'p1' }
  ) =>
    someLookups({
      now: NOW,
      profiles,
      blockTimes: { 10: 5_000 },
      nativeEntries: found ? { [EN]: found } : {}
    });

  it('writes the drop and entry, and takes its votes and board row in the same run', () => {
    const p = planDecision({ chain, target, lookups: lookups() });
    const rowId = nativeEntryRowId(C, EN);
    expect(p.writes.nativeEntries).toEqual([
      expect.objectContaining({
        entryRowId: rowId,
        dropId: EN,
        waveId: WAVE,
        authorId: 'author',
        createdAt: 1_764_500_000_000,
        configVersion: 3
      })
    ]);
    expect(p.writes.votes.upsert.map((v) => [v.entryId, v.value])).toEqual([
      [rowId, 9]
    ]);
    expect(
      p.writes.board.upsert.map((b) => [b.entryId, b.dropId, b.rank])
    ).toEqual([
      [rowId, EN, 1],
      [ROW_1, DROP1, 2]
    ]);
    expect(p.changes.drops).toEqual({ insert: 1, update: 0, delete: 0 });
    expect(p.waiting.entry_without_row).toBeUndefined();
  });

  it('never writes one the chain withdrew or disqualified before 6529.io had it', () => {
    for (const status of ['withdrawn', 'disqualified']) {
      const released = aChainDecisionState(chain.decision, {
        ...chain,
        entries: chain.entries.map((e) =>
          e.entryId === EN ? { ...e, status } : e
        )
      });
      const p = planDecision({ chain: released, target, lookups: lookups() });
      expect(p.writes.nativeEntries).toEqual([]);
      expect(p.changes.drops).toBeUndefined();
      expect(p.waiting.entry_without_row).toBeUndefined();
      expect(p.waiting.vote_entry_without_row).toBeUndefined();
    }
  });

  it('waits for the author, the manifest, and holds back what fails', () => {
    expect(
      planDecision({ chain, target, lookups: lookups(content, { [V1]: 'p1' }) })
        .waiting
    ).toMatchObject({ native_entry_author_unmapped: 1, entry_without_row: 1 });
    expect(
      planDecision({ chain, target, lookups: lookups(null) }).waiting
    ).toMatchObject({
      native_entry_manifest_missing: 1
    });
    const held = planDecision({
      chain,
      target,
      lookups: lookups({ ok: false, reason: 'commitment_mismatch' })
    });
    expect(held.writes.nativeEntries).toEqual([]);
    expect(held.waiting).toMatchObject({
      native_entry_held_commitment_mismatch: 1,
      vote_entry_without_row: 1
    });
  });

  it('writes nothing the second time', () => {
    const first = planDecision({ chain, target, lookups: lookups() });
    const after = applyWritesInMemory(target, first.writes);
    const second = planDecision({ chain, target: after, lookups: lookups() });
    expect(planWrites(second)).toBe(0);
  });
});
