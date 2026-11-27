import { AREA_MANIFESTS } from '@/rebuild/manifests';
import { identityManifest } from '@/rebuild/manifests/identity.manifest';
import { probeProfileId } from '@/rebuild/run/probe-fixture.steps';
import {
  PLACEHOLDER_REFERENCE_TABLES,
  PLACEHOLDER_REFERENCES,
  plainValueOf,
  plantPlaceholderReferences,
  referenceRowOf
} from './placeholder-references';
import {
  IDENTITY_WORLD_LEGACY_IDS,
  IDENTITY_WORLD_PLACEHOLDER_IDS
} from './world-ids';

/** The probes' ids as the identity world holds them. */
const PROBES = {
  1: IDENTITY_WORLD_LEGACY_IDS.probe1,
  2: IDENTITY_WORLD_LEGACY_IDS.probe2
} as const;

const column = (
  name: string,
  other: Partial<Parameters<typeof plainValueOf>[0]> = {}
) => ({
  name,
  nullable: false,
  hasDefault: false,
  autoIncrement: false,
  dataType: 'varchar',
  columnType: 'varchar(50)',
  maxLength: 50,
  ...other
});

describe('the placeholder references', () => {
  it('are one row of each kind, each table and column once', () => {
    // Ratings (the mirror's whole table), TDH (site-rows.ts), the activity
    // and latest logs (the site's own code) and the encrypted DM tables
    // (only the DM area's relay records rebuild them) are not planted here.
    const kinds = PLACEHOLDER_REFERENCES.map((it) => it.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    const columns = PLACEHOLDER_REFERENCES.map(
      (it) => `${it.table}.${it.column}`
    );
    expect(new Set(columns).size).toBe(columns.length);
    expect(columns).not.toContain('ratings.rater_profile_id');
    expect(columns).not.toContain('profile_activity_logs.profile_id');
    expect(columns.some((it) => it.startsWith('e2ee_'))).toBe(false);
    expect(PLACEHOLDER_REFERENCES).toHaveLength(27);
  });

  it('go into tables the manifests classify, and the seed lists them', () => {
    const classified = new Set(
      AREA_MANIFESTS.flatMap((it) => Object.keys(it.tables))
    );
    expect(
      PLACEHOLDER_REFERENCE_TABLES.filter((t) => !classified.has(t))
    ).toEqual([]);
    const seed = identityManifest.seeds.find(
      (it) => it.id === 'identity.placeholder-references'
    );
    expect(seed?.writes).toEqual(PLACEHOLDER_REFERENCE_TABLES);
    // After the check that the world holds the probes it names.
    expect(seed?.after).toEqual(['identity.actors-check']);
  });

  it('name the untaken placeholder in the reference column', () => {
    const follow = PLACEHOLDER_REFERENCES.find(
      (it) => it.kind === 'Follows they made'
    )!;
    const row = referenceRowOf(
      follow,
      [
        column('id', { autoIncrement: true, dataType: 'bigint' }),
        column('subscriber_id'),
        column('target_id'),
        column('target_type'),
        column('target_action'),
        column('wave_id', { nullable: true }),
        column('subscribed_to_all_drops', {
          hasDefault: true,
          dataType: 'tinyint'
        })
      ],
      '1',
      PROBES
    );
    expect(row).toEqual({
      subscriber_id: IDENTITY_WORLD_PLACEHOLDER_IDS.untaken,
      target_id: IDENTITY_WORLD_LEGACY_IDS.probe1,
      target_type: 'IDENTITY',
      target_action: 'DROP_CREATED'
    });
  });

  it('give a plain value to every other column that needs one', () => {
    const reaction = PLACEHOLDER_REFERENCES.find(
      (it) => it.kind === 'Drop reactions'
    )!;
    expect(
      referenceRowOf(
        reaction,
        [
          column('profile_id'),
          column('drop_id', { maxLength: 8 }),
          column('reaction', {
            dataType: 'enum',
            columnType: "enum('it''s','b')"
          }),
          column('created_at', { dataType: 'bigint', columnType: 'bigint' }),
          column('seen', { dataType: 'datetime', columnType: 'datetime' }),
          column('meta', { dataType: 'json', columnType: 'json' })
        ],
        '12',
        PROBES
      )
    ).toEqual({
      profile_id: IDENTITY_WORLD_PLACEHOLDER_IDS.untaken,
      drop_id: 'plant-12',
      reaction: "it's",
      created_at: 0,
      seen: '2025-11-18 21:06:40',
      meta: '{}'
    });
  });

  it('names the other probe identity as the one who mutes them', () => {
    const mute = PLACEHOLDER_REFERENCES.find(
      (it) => it.kind === 'Mutes of them'
    )!;
    expect(
      referenceRowOf(
        mute,
        [column('muter_id'), column('muted_identity_id')],
        '3',
        PROBES
      )
    ).toEqual({
      muter_id: IDENTITY_WORLD_LEGACY_IDS.probe2,
      muted_identity_id: IDENTITY_WORLD_PLACEHOLDER_IDS.untaken
    });
  });

  it("names the probes by the world's fixed ids when not given them", async () => {
    const planted: Record<string, unknown>[] = [];
    const db = {
      execute: jest.fn(
        async (sql: string, params?: Record<string, unknown>) => {
          if (sql.includes('information_schema.columns')) {
            return params?.table === 'identity_subscriptions'
              ? [
                  'subscriber_id',
                  'target_id',
                  'target_type',
                  'target_action'
                ].map((name) => ({
                  name,
                  nullable: 'NO',
                  column_default: null,
                  extra: '',
                  data_type: 'varchar',
                  column_type: 'varchar(100)',
                  max_length: 100
                }))
              : [];
          }
          planted.push(params ?? {});
          return [];
        }
      )
    };
    await expect(plantPlaceholderReferences(db as never)).rejects.toThrow(
      /no table/
    );
    expect(planted[0]).toMatchObject({
      v0: probeProfileId(1),
      v3: IDENTITY_WORLD_PLACEHOLDER_IDS.untaken
    });
    expect(probeProfileId(1)).toBe(PROBES[1]);
    expect(probeProfileId(2)).toBe(PROBES[2]);
  });

  it("fails on a table or column the schema doesn't have", async () => {
    const db = { execute: jest.fn(async () => []) };
    await expect(
      plantPlaceholderReferences(db as never, PROBES)
    ).rejects.toThrow(/Follows they made: no table identity_subscriptions/);
    db.execute.mockResolvedValueOnce([
      {
        name: 'other',
        nullable: 'YES',
        column_default: null,
        extra: '',
        data_type: 'varchar',
        column_type: 'varchar(5)',
        max_length: 5
      }
    ] as never);
    await expect(
      plantPlaceholderReferences(db as never, PROBES)
    ).rejects.toThrow(/no column identity_subscriptions.subscriber_id/);
  });
});
