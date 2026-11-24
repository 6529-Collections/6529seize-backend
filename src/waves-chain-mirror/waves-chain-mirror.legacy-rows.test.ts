import {
  legacyCompetitionDecisionId,
  legacyCompetitionEntryId,
  legacyCompetitionId
} from '@/competitions/competition-id';
import { WaveType } from '@/entities/IWave';
import { nativeOriginalPrimaryFixture } from '@/tests/fixtures/native-competition.fixture';
import { aWave } from '@/tests/fixtures/wave.fixture';
import {
  aChainDecision,
  aChainDecisionState,
  aChainEntry,
  aChainResult,
  chainId
} from '@/tests/fixtures/waves-chain-mirror.fixture';
import {
  importedCompetitionRecord,
  importedDecisionRows,
  IMPORT_STARTED_AT_SQL,
  mirrorPlannedRows,
  parseImportedDecisionDoc
} from './waves-chain-mirror.legacy-rows';
import { PlanCounter } from './waves-chain-mirror.plan-support';

const WAVE = '00000000-0000-4000-8000-0000000000b1';
const CREATED = 1_764_000_000_000;
const RESULT = CREATED + 86_400_000;

/** A rank wave as 6529.io held it, and its primary competition's row. */
function primary() {
  const wave = aWave(
    {
      type: WaveType.RANK,
      created_by: 'profile-1',
      created_at: CREATED,
      updated_at: null,
      decisions_strategy: {
        first_decision_time: RESULT,
        subsequent_decisions: [],
        is_rolling: false
      }
    },
    { id: WAVE, name: 'A rank wave', serial_no: 1 }
  );
  return nativeOriginalPrimaryFixture(wave);
}

/** The decision document the import writes from a competition's object. */
function docOf(record: ReturnType<typeof primary>, fields = {}) {
  return Buffer.from(
    `${JSON.stringify({
      v: 1,
      kind: 'decision',
      id: record.id,
      wave_id: record.wave_id,
      type: record.type,
      title: record.title,
      description: record.description,
      config_version: record.config_version,
      participation: record.participation_config,
      voting: record.voting_config,
      decisions: record.decision_config,
      winners: record.winner_config,
      outcome_config: record.outcome_config,
      capabilities: ['MAIN_STAGE'],
      created_at: record.created_at,
      published_at: record.published_at,
      ended_at: record.ended_at,
      archived_at: record.archived_at,
      lifecycle: record.lifecycle,
      ...fields
    })}\n`
  );
}

describe('imported decisions', () => {
  it("gives a primary competition's row back as 6529.io held it", () => {
    const record = primary();
    const read = parseImportedDecisionDoc(docOf(record));
    if (!read.ok) throw new Error(read.reason);
    expect(read.doc.capabilities).toEqual(['MAIN_STAGE']);
    const { presentation_config, ...row } = importedCompetitionRecord(
      read.doc
    ) as unknown as Record<string, unknown>;
    expect(presentation_config).toEqual([]);
    // Every column the fixture writes, updated_at included (never edited).
    expect(row).toEqual(record);
  });

  it("refuses a document that isn't a decision's", () => {
    expect(parseImportedDecisionDoc(Buffer.from('{'))).toEqual({
      ok: false,
      reason: 'decision_document_not_json'
    });
    expect(
      parseImportedDecisionDoc(Buffer.from('{"v":1,"kind":"wave"}'))
    ).toEqual({ ok: false, reason: 'decision_document_not_a_decision' });
    expect(
      parseImportedDecisionDoc(docOf(primary(), { type: 'NONE' }))
    ).toEqual({ ok: false, reason: 'decision_document_invalid' });
  });

  it("writes a primary decision's entries, result and winner as 6529.io derives them", () => {
    const competitionId = legacyCompetitionId(WAVE);
    const D = chainId('d1');
    const drop = (n: number) =>
      `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const chain = aChainDecisionState(
      aChainDecision({ decisionId: D, legacyId: competitionId }),
      {
        entries: [
          aChainEntry({
            entryId: chainId('e1'),
            decisionId: D,
            legacyId: drop(1),
            author: chainId('a1')
          }),
          aChainEntry({
            entryId: chainId('e2'),
            decisionId: D,
            legacyId: drop(2),
            author: chainId('a1'),
            status: 'winner',
            data: { createdMs: CREATED + 1000, resultTime: RESULT, rank: 1 }
          }),
          // An author with no profile waits.
          aChainEntry({
            entryId: chainId('e3'),
            decisionId: D,
            legacyId: drop(3),
            author: chainId('a9')
          }),
          // Made on the chain: the decisions pass's.
          aChainEntry({
            entryId: chainId('e4'),
            decisionId: D,
            origin: 'native'
          })
        ],
        results: [
          aChainResult({
            resultTime: RESULT,
            origin: 'legacy',
            data: {
              winners: [
                { entryId: chainId('e2'), rank: 1, score: '42' },
                // A winner with no score waits.
                { entryId: chainId('e1'), rank: 2 }
              ]
            }
          }),
          // The chain's own result: the decisions pass's.
          aChainResult({ resultTime: RESULT + 1, origin: 'native' })
        ]
      }
    );
    const counter = new PlanCounter();
    const decisionId = legacyCompetitionDecisionId(competitionId, RESULT);
    const winnerId = legacyCompetitionEntryId(competitionId, drop(2));
    const rows = importedDecisionRows(
      chain,
      { id: competitionId, waveId: WAVE, primary: true, configVersion: 1 },
      new Map([[chainId('a1'), 'profile-1']]),
      counter
    );
    expect(rows.entries).toEqual([
      {
        id: legacyCompetitionEntryId(competitionId, drop(1)),
        competition_id: competitionId,
        wave_id: WAVE,
        drop_id: drop(1),
        submitter_id: 'profile-1',
        status: 'ACTIVE',
        config_version: 1,
        submitted_at: 1_763_000_000_000,
        won_at: null,
        rank: null,
        decision_id: null
      },
      {
        id: winnerId,
        competition_id: competitionId,
        wave_id: WAVE,
        drop_id: drop(2),
        submitter_id: 'profile-1',
        status: 'WINNER',
        config_version: 1,
        submitted_at: CREATED + 1000,
        won_at: RESULT,
        rank: 1,
        decision_id: decisionId
      }
    ]);
    expect(rows.results).toEqual([
      {
        id: decisionId,
        competition_id: competitionId,
        scheduled_at: RESULT,
        decided_at: RESULT,
        status: 'COMPLETED',
        execution_key: `native:${competitionId}:${RESULT}`,
        created_at: RESULT
      }
    ]);
    expect(rows.winners).toEqual([
      {
        competition_id: competitionId,
        entry_id: winnerId,
        decision_id: decisionId,
        rank: 1,
        final_rating: 42,
        created_at: RESULT
      }
    ]);
    expect(counter.waiting).toEqual({
      imported_entry_author_unmapped: 1,
      imported_winner_without_score: 1
    });

    // Not a wave's primary: 6529.io's entry ids were random, planned.
    const other = new PlanCounter();
    const planned = importedDecisionRows(
      chain,
      { id: competitionId, waveId: WAVE, primary: false, configVersion: 1 },
      new Map([[chainId('a1'), 'profile-1']]),
      other
    );
    expect(planned.entries).toEqual([]);
    expect(planned.winners).toEqual([]);
    expect(other.waiting).toMatchObject({
      imported_entry_id_planned: 3,
      imported_winner_entry_without_row: 2
    });
  });

  it("lists every planned row with a reason, scheduled work or none, and the run's switch time", () => {
    const rows = mirrorPlannedRows({ switchAt: RESULT });
    for (const row of rows) {
      expect(row.table).toMatch(/^[a-z_]+$/);
      expect(row.where.length).toBeGreaterThan(0);
      expect(row.reason.length).toBeGreaterThan(10);
      expect(row.until).toBe('2026-12-04');
      expect(row.columns === null || row.columns.length > 0).toBe(true);
      // Imported rows by the chain index's legacy ids, never by "not made
      // on the chain".
      expect(row.where).not.toContain("not like '0x%'");
    }
    // Scheduled work named, or none said plainly.
    const reader = rows.filter((r) => r.change.includes('import-files reader'));
    expect(reader.map((r) => r.table)).toEqual([
      'waves',
      'drops',
      'drops_parts'
    ]);
    for (const row of rows.filter((r) => !reader.includes(r))) {
      expect(row.change).toBe('No change is scheduled yet.');
    }
    // History before the switch, at the time given.
    const history = rows.filter((r) => r.where.includes('occurred_at'));
    expect(history).toHaveLength(2);
    for (const row of history) {
      expect(row.where).toContain(`occurred_at < ${RESULT}`);
    }
    expect(() => mirrorPlannedRows({ switchAt: 0 })).toThrow();
    // Or the chain index's kept start, read with the where; no other SQL.
    const kept = mirrorPlannedRows({ switchAt: 'chain-index' });
    expect(IMPORT_STARTED_AT_SQL).toBe(
      "(select import_started_at from waves_chain_index_state where name = 'waves')"
    );
    for (const row of kept.filter((r) => r.where.includes('occurred_at'))) {
      expect(row.where).toContain(`occurred_at < ${IMPORT_STARTED_AT_SQL}`);
    }
    expect(() =>
      mirrorPlannedRows({ switchAt: '1 or 1 = 1' as unknown as 'chain-index' })
    ).toThrow();
  });
});
