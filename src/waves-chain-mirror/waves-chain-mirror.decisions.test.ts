import {
  aChainDecisionRow,
  aDecisionConfig,
  aDecisionDoc,
  chainWord,
  FIRST_RESULT
} from '@/tests/fixtures/waves-chain-mirror.objects.fixture';
import {
  chainDecisionConfigOf,
  chainNativeDecisionOf,
  decisionDraftOf,
  parseDecisionDocument,
  repCategoryId,
  templateOutcomes
} from './waves-chain-mirror.decisions';
import { DOC_CLASS, docCommitment } from './waves-chain-mirror.docs';

const D = chainWord('d1');
const W = chainWord('0b');
const G = chainWord('0a');
const CREDITOR = chainWord('33');
const NONCE = `0x${'5a'.repeat(16)}`;

const bytesOf = (doc: unknown) => Buffer.from(`${JSON.stringify(doc)}\n`);
const docOf = (doc: unknown) => {
  const read = parseDecisionDocument(bytesOf(doc));
  if (!read.ok) throw new Error(read.reason);
  return read.value;
};
const configOf = (fields: Record<string, unknown> = {}) =>
  chainDecisionConfigOf(aDecisionConfig(fields))!;

describe('waves chain mirror decisions', () => {
  it('reads a chain_decisions row: config, groups (none for the zero id) and document', () => {
    const read = chainNativeDecisionOf(
      aChainDecisionRow(D, W, {
        configVersion: 3,
        metadataCid: '0x0155ABCD',
        submitGroup: G
      })
    );
    expect(read).toMatchObject({
      ok: true,
      value: {
        decisionId: D,
        waveId: W,
        configVersion: 3,
        metadataCid: '0x0155abcd',
        submitGroupId: G,
        voteGroupId: null,
        config: {
          kind: 1,
          creditSource: 1,
          creditor: null,
          timeLock: BigInt(3_600_000),
          gaps: [BigInt(86_400_000)],
          maxEntriesPerAuthor: 64
        }
      }
    });
    expect(
      chainNativeDecisionOf({
        ...aChainDecisionRow(D, W),
        data: { configVersion: 1, config: { kind: 'one' } }
      })
    ).toEqual({ ok: false, reason: 'decision_row_unread' });
  });

  it('names a REP category as the chain does, whatever its case', () => {
    expect(repCategoryId('Art')).toMatch(/^0x[0-9a-f]{64}$/);
    expect(repCategoryId('Art')).toBe(repCategoryId('art'));
    expect(repCategoryId('Art')).not.toBe(repCategoryId('Music'));
  });

  it("takes a template's outcomes only under the config's commitment", () => {
    const template = {
      v: 1,
      kind: 'outcomes',
      decision: null,
      outcomes: [{ type: 'MANUAL', description: 'A prize' }],
      nonce: NONCE
    };
    const bytes = bytesOf(template);
    const hash = docCommitment(
      DOC_CLASS.OUTCOME_TEMPLATE,
      `${NONCE}${'00'.repeat(16)}`,
      bytes
    );
    expect(templateOutcomes(bytes, hash)).toEqual({
      ok: true,
      value: template.outcomes
    });
    expect(
      templateOutcomes(
        bytesOf({
          ...template,
          outcomes: [{ type: 'MANUAL', description: 'x' }]
        }),
        hash
      )
    ).toEqual({ ok: false, reason: 'decision_outcomes_commitment' });
    expect(templateOutcomes(bytesOf({ v: 1 }), hash)).toEqual({
      ok: false,
      reason: 'decision_outcomes_unread'
    });
  });

  it("makes 6529.io's draft from the document, the chain's rules and groups winning", () => {
    const read = decisionDraftOf({
      doc: docOf(aDecisionDoc({}, { time_lock_ms: 7_200_000 })),
      config: configOf({
        minVote: '0',
        perEntryCap: '500',
        votingStart: '1765000000000',
        maxEntriesPerAuthor: 3
      }),
      submitGroupId: 'readers-1',
      voteGroupId: null,
      creditorId: null,
      outcomes: [{ type: 'MANUAL', description: 'From the template' }]
    });
    expect(read).toMatchObject({
      ok: true,
      value: {
        draft: {
          title: 'Made on the chain',
          description: 'Pick the best',
          participation: {
            scope: { group_id: 'readers-1' },
            no_of_applications_allowed_per_participant: 3,
            required_media: ['IMAGE'],
            period: { min: null, max: null }
          },
          voting: {
            scope: { group_id: null },
            credit_type: 'TDH',
            credit_scope: 'WAVE',
            forbid_negative_votes: true,
            period: { min: 1_765_000_000_000, max: null }
          },
          rules: {
            type: 'RANK',
            time_lock_ms: 3_600_000,
            max_votes_per_identity_to_drop: 500,
            max_winners: null,
            decisions_strategy: {
              first_decision_time: FIRST_RESULT,
              subsequent_decisions: [86_400_000],
              is_rolling: false
            }
          },
          outcomes: [{ type: 'MANUAL', description: 'From the template' }],
          presentation: []
        },
        differences: [
          'rules.max_votes_per_identity_to_drop',
          'rules.time_lock_ms',
          'participation.no_of_applications_allowed_per_participant',
          'voting.forbid_negative_votes',
          'voting.period'
        ]
      }
    });
  });

  it('maps an approval: threshold, hold and most winners from the chain', () => {
    const read = decisionDraftOf({
      doc: docOf(
        aDecisionDoc(
          { type: 'APPROVE' },
          {
            type: 'APPROVE',
            winning_threshold: 5,
            winning_threshold_min_duration_ms: 0,
            max_winners: 2,
            time_lock_ms: null,
            decisions_strategy: null
          }
        )
      ),
      config: configOf({
        kind: 2,
        threshold: '10',
        holdMs: '0',
        maxWinners: 4,
        timeLock: '0',
        firstResult: '0',
        gaps: []
      }),
      submitGroupId: null,
      voteGroupId: null,
      creditorId: null,
      outcomes: []
    });
    expect(read).toMatchObject({
      ok: true,
      value: {
        draft: {
          rules: {
            type: 'APPROVE',
            winning_threshold: 10,
            winning_threshold_min_duration_ms: 0,
            max_winners: 4,
            time_lock_ms: null,
            decisions_strategy: null
          }
        }
      }
    });
  });

  it('takes a REP credit only with a category whose name is the chain id', () => {
    const doc = (category: string) =>
      docOf(
        aDecisionDoc({
          voting: {
            ...aDecisionDoc().voting,
            credit_type: 'REP',
            credit_category: category
          }
        })
      );
    const config = configOf({
      creditSource: 4,
      creditParam: repCategoryId('Art'),
      creditor: CREDITOR
    });
    const input = {
      config,
      submitGroupId: null,
      voteGroupId: null,
      creditorId: 'profile-rater',
      outcomes: []
    };
    expect(decisionDraftOf({ ...input, doc: doc('Art') })).toMatchObject({
      ok: true,
      value: {
        draft: {
          voting: {
            credit_type: 'REP',
            credit_category: 'Art',
            creditor_id: 'profile-rater'
          }
        }
      }
    });
    expect(decisionDraftOf({ ...input, doc: doc('Music') })).toEqual({
      ok: false,
      reason: 'decision_rep_category_unnamed'
    });
  });

  it("refuses what the chain or 6529.io's draft schema doesn't take", () => {
    const input = {
      config: configOf(),
      submitGroupId: null,
      voteGroupId: null,
      creditorId: null,
      outcomes: []
    };
    expect(
      decisionDraftOf({ ...input, doc: docOf(aDecisionDoc({ title: '' })) })
    ).toMatchObject({ ok: false, reason: 'decision_draft_invalid' });
    expect(
      decisionDraftOf({
        ...input,
        config: configOf({ creditSource: 2 }),
        doc: docOf(aDecisionDoc())
      })
    ).toEqual({ ok: false, reason: 'decision_credit_unsupported' });
    expect(parseDecisionDocument(bytesOf({ v: 1, kind: 'wave' }))).toEqual({
      ok: false,
      reason: 'decision_document_unread'
    });
  });
});
