import {
  anonymousCompetitionAuthor,
  competitionAnonymityService,
  publicCompetitionDropSql
} from './competition-anonymity';
import { AuthenticationContext } from '@/auth-context';
import { ProfileProxyActionType } from '@/entities/IProfileProxyAction';
import { COMPETITIONS_TABLE, COMPETITION_ENTRIES_TABLE } from '@/constants';
import { competitionRepository } from '@/competitions/competition.repository';
import { competitionEntryRepository } from '@/competitions/competition-entry.repository';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';

describe('Anonymous author presentation', () => {
  it('preserves required identity display fields without retaining wallets or profile data', () => {
    const result = anonymousCompetitionAuthor(
      {
        id: 'owner',
        normalised_handle: 'owner-handle',
        display: 'Owner Display',
        primary_wallet: 'owner-wallet',
        consolidation_key: 'owner-consolidation',
        wallets: [{ address: 'owner-wallet' }],
        banner1: 'owner-banner',
        banner2: 'owner-banner'
      },
      'drop'
    );
    expect(result).toMatchObject({
      normalised_handle: 'Anonymous',
      display: 'Anonymous',
      primary_wallet: '',
      consolidation_key: '',
      banner1: null,
      banner2: null
    });
    expect(result).not.toHaveProperty('wallets');
    expect(JSON.stringify(result)).not.toContain('owner');
  });

  it('does not reuse ownership identifiers or retain arbitrary profile fields', () => {
    const profile = {
      id: 'real-owner',
      handle: 'Real Artist',
      primary_address: 'real-address',
      unknown_private_field: 'private',
      badges: { profile_wave_id: 'owners-wave' }
    };
    const first = anonymousCompetitionAuthor(profile, 'entry-drop-one');
    const second = anonymousCompetitionAuthor(profile, 'entry-drop-two');
    expect(first.id).not.toBe(profile.id);
    expect(first.id).not.toBe(second.id);
    expect(first).toMatchObject({ is_anonymous: true, handle: 'Anonymous' });
    expect(first).not.toHaveProperty('unknown_private_field');
    expect(first).not.toHaveProperty('badges.profile_wave_id');
    expect(JSON.stringify(first)).not.toContain('real-address');
    expect(profile.handle).toBe('Real Artist');
  });
});

const competitionId = 'anonymous-competition';
const owner = 'anonymous-entry-owner';
const entries = ['unrevealed-one', 'unrevealed-two', 'revealed-winner'];
const seeds = [
  {
    table: COMPETITIONS_TABLE,
    rows: [
      {
        id: competitionId,
        wave_id: 'anonymous-wave',
        legacy_wave_id: null,
        execution_mode: 'ACTIVE',
        type: 'RANK',
        lifecycle: 'PUBLISHED',
        title: 'Anonymous competition',
        participation_config: { anonymous_submissions: true },
        voting_config: {},
        decision_config: {},
        winner_config: {},
        outcome_config: [],
        created_at: 1,
        updated_at: 1
      }
    ]
  },
  {
    table: COMPETITION_ENTRIES_TABLE,
    rows: entries.map((id) => ({
      id,
      competition_id: competitionId,
      wave_id: 'anonymous-wave',
      drop_id: id,
      submitter_id: owner,
      status: id === 'revealed-winner' ? 'WINNER' : 'ACTIVE',
      won_at: id === 'revealed-winner' ? 2 : null,
      config_version: 1,
      submitted_at: 1
    }))
  }
];

describeWithSeed('Competition identity disclosure', seeds, () => {
  it('does not grant a delegate private attribution without wave read permission', async () => {
    const proxy = new AuthenticationContext({
      authenticatedWallet: null,
      authenticatedProfileId: 'delegate',
      roleProfileId: owner,
      activeProxyActions: []
    });
    expect(
      await competitionAnonymityService.hiddenDropIds(entries, {
        authenticationContext: proxy
      })
    ).toEqual(new Set(['unrevealed-one', 'unrevealed-two']));
    const reader = new AuthenticationContext({
      authenticatedWallet: null,
      authenticatedProfileId: 'delegate',
      roleProfileId: owner,
      activeProxyActions: [
        {
          id: 'read',
          type: ProfileProxyActionType.READ_WAVE,
          credit_amount: null,
          credit_spent: null
        }
      ]
    });
    expect(
      await competitionAnonymityService.hiddenDropIds(entries, {
        authenticationContext: reader
      })
    ).toEqual(new Set());
  });

  it('retains a losing entry privacy tombstone when its content is deleted', async () => {
    await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
      competitionEntryRepository.deleteEntry('unrevealed-one', { connection })
    );
    expect(
      await competitionAnonymityService.hiddenDropIds(entries, {})
    ).toEqual(new Set(['unrevealed-one', 'unrevealed-two']));
    const rows = await sqlExecutor.execute<{ status: string }>(
      `select status from ${COMPETITION_ENTRIES_TABLE} where id='unrevealed-one'`
    );
    expect(rows).toEqual([{ status: 'WITHDRAWN' }]);
    const page = await competitionRepository.listNativeEntries(
      competitionId,
      { limit: 50, offset: 0, direction: 'ASC' },
      {}
    );
    expect(page.data.map((entry) => entry.id)).not.toContain('unrevealed-one');
  });

  it('holds the competition and entry locks through tombstone deletion until commit', async () => {
    const assertWinnerCannotAcquireLocks = async () => {
      for (const { table, id } of [
        { table: COMPETITIONS_TABLE, id: competitionId },
        { table: COMPETITION_ENTRIES_TABLE, id: 'unrevealed-one' }
      ]) {
        await expect(
          sqlExecutor.executeNativeQueriesInTransaction((connection) =>
            sqlExecutor.execute(
              `select id from ${table} where id=:id for update nowait`,
              { id },
              { wrappedConnection: connection }
            )
          )
        ).rejects.toMatchObject({ errno: 3572 });
      }
    };

    await expect(
      competitionEntryRepository.deleteEntry('unrevealed-one', {})
    ).rejects.toThrow('Entry deletion requires a transaction');
    await sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
      const ctx = { connection };
      const memberships = await competitionEntryRepository.lockDropMemberships(
        'unrevealed-one',
        ctx
      );
      expect(memberships.map(({ id }) => id)).toEqual(['unrevealed-one']);
      await assertWinnerCannotAcquireLocks();
      await competitionEntryRepository.deleteEntry('unrevealed-one', ctx);
      await assertWinnerCannotAcquireLocks();
    });

    const rows = await sqlExecutor.executeNativeQueriesInTransaction(
      (connection) =>
        sqlExecutor.execute<{ status: string; won_at: number | null }>(
          `select status,won_at from ${COMPETITION_ENTRIES_TABLE} where id='unrevealed-one' for update nowait`,
          {},
          { wrappedConnection: connection }
        )
    );
    expect(rows).toEqual([{ status: 'WITHDRAWN', won_at: null }]);
  });

  it.each([{}, { anonymous_submissions: false }])(
    'hard-deletes public entries with participation config %p',
    async (participationConfig) => {
      await sqlExecutor.execute(
        `update ${COMPETITIONS_TABLE} set participation_config=:participationConfig where id=:competitionId`,
        {
          competitionId,
          participationConfig: JSON.stringify(participationConfig)
        }
      );

      await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        competitionEntryRepository.deleteEntry('unrevealed-one', { connection })
      );

      const rows = await sqlExecutor.execute<{ id: string }>(
        `select id from ${COMPETITION_ENTRIES_TABLE} order by id`
      );
      expect(rows).toEqual([
        { id: 'revealed-winner' },
        { id: 'unrevealed-two' }
      ]);
    }
  );

  it('hard-deletes a revealed winner in an anonymous competition', async () => {
    await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
      competitionEntryRepository.deleteEntry('revealed-winner', { connection })
    );

    const rows = await sqlExecutor.execute<{ id: string }>(
      `select id from ${COMPETITION_ENTRIES_TABLE} order by id`
    );
    expect(rows).toEqual([{ id: 'unrevealed-one' }, { id: 'unrevealed-two' }]);
    expect(
      await competitionAnonymityService.hiddenDropIds(entries, {})
    ).toEqual(new Set(['unrevealed-one', 'unrevealed-two']));
  });

  it('reveals only the winning entry and retains private owner access', async () => {
    expect(
      await competitionAnonymityService.hiddenDropIds(entries, {})
    ).toEqual(new Set(['unrevealed-one', 'unrevealed-two']));
    const ctx = {
      authenticationContext: AuthenticationContext.fromProfileId(owner)
    };
    expect(
      await competitionAnonymityService.hiddenDropIds(entries, ctx)
    ).toEqual(new Set());
    expect(
      await competitionAnonymityService.hiddenDropIds(entries, ctx, {
        includeOwner: true
      })
    ).toEqual(new Set(['unrevealed-one', 'unrevealed-two']));
    const page = { limit: 1, offset: 0, direction: 'ASC' as const };
    const publicResult = await competitionRepository.listNativeEntries(
      competitionId,
      page,
      {},
      undefined,
      owner
    );
    expect(publicResult.data.map((entry) => entry.id)).toEqual([
      'revealed-winner'
    ]);
    expect(publicResult.has_more).toBe(false);
    const ownResult = await competitionRepository.listNativeEntries(
      competitionId,
      page,
      ctx,
      undefined,
      owner
    );
    expect(ownResult.has_more).toBe(true);
  });

  it('keeps losing entries private across later wins and does not undo a disclosure', async () => {
    await sqlExecutor.execute(
      `update ${COMPETITION_ENTRIES_TABLE} set status='WINNER', won_at=3 where id='unrevealed-one'`
    );
    expect(
      await competitionAnonymityService.hiddenDropIds(entries, {})
    ).toEqual(new Set(['unrevealed-two']));
    await sqlExecutor.execute(
      `update ${COMPETITION_ENTRIES_TABLE} set status='DISQUALIFIED' where id='unrevealed-one'`
    );
    expect(
      await competitionAnonymityService.hiddenDropIds(entries, {})
    ).toEqual(new Set(['unrevealed-two']));
  });

  it('filters author-linked results before pagination and defaults old configuration to public', async () => {
    const rows = await sqlExecutor.execute<{ id: string }>(
      `select d.id from ${COMPETITION_ENTRIES_TABLE} d where ${publicCompetitionDropSql('d')} order by d.id limit 1`
    );
    expect(rows.map((row) => row.id)).toEqual(['revealed-winner']);
    await sqlExecutor.execute(
      `update ${COMPETITIONS_TABLE} set participation_config='{}' where id=:competitionId`,
      { competitionId }
    );
    expect(
      await competitionAnonymityService.hiddenDropIds(entries, {})
    ).toEqual(new Set());
  });
});
