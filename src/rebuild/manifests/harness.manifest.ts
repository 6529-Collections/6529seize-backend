import { AreaManifest } from '@/rebuild/manifest.types';

/**
 * Schema objects that hold no data: TypeORM and db-migrate bookkeeping, a test
 * fixture table and the competition facade views.
 * Classes start from the migration map; the area confirms or changes each one.
 */
export const harnessManifest: AreaManifest = {
  area: 'harness',
  flags: {},
  tables: {
    migrations: {
      class: 'SCHEMA',
      why: "db-migrate's record of applied migrations.",
      origin: 'runtime'
    },
    sql_transaction_fixture: {
      class: 'SCHEMA',
      why: 'Fixture table code creates for transaction tests.'
    },
    typeorm_metadata: {
      class: 'SCHEMA',
      why: "TypeORM's own metadata.",
      origin: 'runtime'
    },
    legacy_get_drop_ranks: {
      class: 'VIEW',
      why: 'Competition facade view over the competitions tables; the schema build makes it.'
    },
    legacy_get_drop_real_vote_in_time: {
      class: 'VIEW',
      why: 'Competition facade view over the competitions tables; the schema build makes it.'
    },
    legacy_get_drop_real_voter_vote_in_time: {
      class: 'VIEW',
      why: 'Competition facade view over the competitions tables; the schema build makes it.'
    },
    legacy_get_drop_voter_states: {
      class: 'VIEW',
      why: 'Competition facade view over the competitions tables; the schema build makes it.'
    },
    legacy_get_drops: {
      class: 'VIEW',
      why: 'Competition facade view over the competitions tables; the schema build makes it.'
    },
    legacy_get_wave_decision_winner_drops: {
      class: 'VIEW',
      why: 'Competition facade view over the competitions tables; the schema build makes it.'
    },
    legacy_get_wave_decisions: {
      class: 'VIEW',
      why: 'Competition facade view over the competitions tables; the schema build makes it.'
    },
    legacy_get_wave_leaderboard_entries: {
      class: 'VIEW',
      why: 'Competition facade view over the competitions tables; the schema build makes it.'
    },
    legacy_get_wave_outcome_distribution_items: {
      class: 'VIEW',
      why: 'Competition facade view over the competitions tables; the schema build makes it.'
    },
    legacy_get_wave_outcomes: {
      class: 'VIEW',
      why: 'Competition facade view over the competitions tables; the schema build makes it.'
    },
    legacy_get_wave_voting_credit_nfts: {
      class: 'VIEW',
      why: 'Competition facade view over the competitions tables; the schema build makes it.'
    },
    legacy_get_waves: {
      class: 'VIEW',
      why: 'Competition facade view over the competitions tables; the schema build makes it.'
    },
    legacy_get_waves_decision_pauses: {
      class: 'VIEW',
      why: 'Competition facade view over the competitions tables; the schema build makes it.'
    },
    legacy_get_winner_drop_voter_votes: {
      class: 'VIEW',
      why: 'Competition facade view over the competitions tables; the schema build makes it.'
    }
  },
  seeds: [],
  rebuilders: [],
  probes: []
};
