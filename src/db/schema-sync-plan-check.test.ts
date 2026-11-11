import fc from 'fast-check';
import {
  checkSchemaPlan,
  destructivePlanDecision,
  destructivePlanSha256,
  informationSchemaCatalog,
  isDestructivePlanAcknowledgement,
  parseSchemaStatement,
  SchemaCatalog,
  schemaSyncDestructiveGuardMode
} from './schema-sync-plan-check';

type IndexFact = { unique: boolean; columns: string[] };

/** Catalog facts keyed by `table.column` and `table.index`. */
function fakeCatalog({
  generatedColumns = [],
  plainColumns = [],
  indexes = {}
}: {
  generatedColumns?: string[];
  plainColumns?: string[];
  indexes?: Record<string, IndexFact>;
} = {}): SchemaCatalog & { lookups: string[] } {
  const lookups: string[] = [];
  return {
    lookups,
    async column(table, column) {
      const key = `${table.name}.${column}`;
      lookups.push(key);
      if (generatedColumns.includes(key)) return { generated: true };
      if (plainColumns.includes(key)) return { generated: false };
      return null;
    },
    async index(table, index) {
      const key = `${table.name}.${index}`;
      lookups.push(key);
      return indexes[key] ?? null;
    }
  };
}

async function kinds(sql: string[], catalog = fakeCatalog()) {
  const check = await checkSchemaPlan(
    sql.map((query) => ({ query })),
    catalog
  );
  return check.statements.map((it) => it.kind);
}

// TypeORM writes identifiers without backticks inside them; keep generated
// names in that space so they read like real table and column names.
const identifier = fc.stringMatching(/^[a-z_][a-z0-9_]{0,30}$/);
const columnDefinition = fc.oneof(
  fc.constantFrom(
    'int NOT NULL',
    "varchar(255) NULL DEFAULT 'a, b'",
    'decimal(10,2) NOT NULL',
    "enum('x','y') NOT NULL",
    "text NULL COMMENT 'DROP COLUMN `x`, DROP INDEX `y`'"
  ),
  fc.string().map((text) => `int NULL COMMENT '${text}'`)
);

describe('parseSchemaStatement', () => {
  it.each([
    ['CREATE TABLE `t` (`id` int NOT NULL) ENGINE=InnoDB', 'create_table'],
    ['DROP TABLE `t`', 'drop_table'],
    ['RENAME TABLE `a` TO `b`', 'rename_table'],
    ['CREATE VIEW `v` AS SELECT 1', 'create_view'],
    ['DROP VIEW `v`', 'drop_view'],
    ['CREATE UNIQUE INDEX `u` ON `t` (`a`, `b`)', 'create_index'],
    ['DROP INDEX `i` ON `db`.`t`', 'drop_index'],
    [
      'INSERT INTO `typeorm_metadata`(`database`, `schema`, `table`, `type`, `name`, `value`) VALUES (?, ?, ?, ?, ?, ?)',
      'metadata'
    ],
    [
      'UPDATE `db`.`typeorm_metadata` SET `value` = ? WHERE `type` = ?',
      'metadata'
    ],
    ['DELETE FROM `typeorm_metadata` WHERE `type` = ?', 'metadata'],
    ['DELETE FROM `drops` WHERE 1', 'unknown'],
    ['TRUNCATE TABLE `drops`', 'unknown']
  ])('recognises %s', (sql, op) => {
    expect(parseSchemaStatement(sql).op).toBe(op);
  });

  it.each([
    ['ADD `c` int NULL', 'add_column'],
    ['DROP COLUMN `c`', 'drop_column'],
    ['CHANGE `c` `c` int NOT NULL', 'change_column'],
    ['ADD UNIQUE INDEX `u` (`c`)', 'add_index'],
    ['DROP INDEX `u`', 'drop_index'],
    ['DROP INDEX `a`, ADD UNIQUE INDEX `b` (`c`)', 'rename_index'],
    ['ADD PRIMARY KEY (`a`, `b`)', 'add_primary_key'],
    ['DROP PRIMARY KEY', 'drop_primary_key'],
    [
      'ADD CONSTRAINT `fk` FOREIGN KEY (`a`) REFERENCES `o`(`id`)',
      'add_foreign_key'
    ],
    ['DROP FOREIGN KEY `fk`', 'drop_foreign_key'],
    [
      'DROP FOREIGN KEY `a`, ADD CONSTRAINT `b` FOREIGN KEY (`c`) REFERENCES `o`(`id`)',
      'rename_foreign_key'
    ],
    ["COMMENT 'x'", 'comment'],
    ['ENGINE=MyISAM', 'unknown']
  ])('recognises the ALTER TABLE clause %s', (clause, op) => {
    const parsed = parseSchemaStatement(`ALTER TABLE \`t\` ${clause}`);
    expect(parsed).toMatchObject({ op: 'alter_table', clause: { op } });
  });

  it('reads the table path with and without a schema', () => {
    expect(parseSchemaStatement('DROP INDEX `i` ON `t`')).toEqual({
      op: 'drop_index',
      index: 'i',
      table: { schema: null, name: 't' }
    });
    expect(
      parseSchemaStatement('ALTER TABLE `db`.`t` DROP COLUMN `c`')
    ).toEqual({
      op: 'alter_table',
      table: { schema: 'db', name: 't' },
      clause: { op: 'drop_column', column: 'c' }
    });
  });
});

describe('checkSchemaPlan', () => {
  it('lets additive and bookkeeping statements through without catalog reads', async () => {
    const catalog = fakeCatalog();
    expect(
      await kinds(
        [
          'CREATE TABLE `t` (`id` int NOT NULL, PRIMARY KEY (`id`)) ENGINE=InnoDB',
          'ALTER TABLE `t` ADD `c` int NULL',
          'CREATE INDEX `i` ON `t` (`c`)',
          'ALTER TABLE `t` ADD UNIQUE INDEX `u` (`c`)',
          "ALTER TABLE `t` COMMENT 'x'",
          'INSERT INTO `typeorm_metadata`(`type`) VALUES (?)'
        ],
        catalog
      )
    ).toEqual([
      'additive',
      'additive',
      'additive',
      'additive',
      'additive',
      'bookkeeping'
    ]);
    expect(catalog.lookups).toEqual([]);
  });

  it('treats column changes and renames as in-place', async () => {
    expect(
      await kinds([
        "ALTER TABLE `t` CHANGE `c` `c` varchar(64) NOT NULL DEFAULT 'x'",
        'ALTER TABLE `t` CHANGE `old` `new` int NULL',
        'ALTER TABLE `t` DROP INDEX `IDX_a`, ADD UNIQUE INDEX `IDX_b` (`c`)',
        'DROP VIEW `v`'
      ])
    ).toEqual(['in_place', 'in_place', 'in_place', 'in_place']);
  });

  it('flags dropping a plain column but not a generated one', async () => {
    const catalog = fakeCatalog({
      plainColumns: ['t.plain'],
      generatedColumns: ['t.derived']
    });
    expect(
      await kinds(
        [
          'ALTER TABLE `t` DROP COLUMN `plain`',
          'ALTER TABLE `t` DROP COLUMN `derived`',
          'ALTER TABLE `t` DROP COLUMN `missing`'
        ],
        catalog
      )
    ).toEqual(['destructive', 'in_place', 'destructive']);
  });

  it('flags dropping a unique index unless the plan recreates it on the same columns', async () => {
    const catalog = fakeCatalog({
      indexes: {
        't.plain': { unique: false, columns: ['a'] },
        't.uq_kept': { unique: true, columns: ['a', 'b'] },
        't.uq_lost': { unique: true, columns: ['c'] },
        't.uq_moved': { unique: true, columns: ['d'] }
      }
    });
    expect(
      await kinds(
        [
          'DROP INDEX `plain` ON `t`',
          'DROP INDEX `uq_kept` ON `t`',
          'ALTER TABLE `t` DROP INDEX `uq_lost`',
          'DROP INDEX `uq_moved` ON `t`',
          'DROP INDEX `unknown` ON `t`',
          'CREATE UNIQUE INDEX `uq_kept` ON `t` (`a`, `b`)',
          'CREATE UNIQUE INDEX `uq_moved` ON `t` (`d`, `e`)'
        ],
        catalog
      )
    ).toEqual([
      'in_place',
      'in_place',
      'destructive',
      'destructive',
      'destructive',
      'additive',
      'additive'
    ]);
  });

  it('flags dropping the primary key unless it is re-added on the same columns', async () => {
    const catalog = fakeCatalog({
      indexes: { 't.PRIMARY': { unique: true, columns: ['id'] } }
    });
    expect(
      await kinds(
        [
          'ALTER TABLE `t` DROP PRIMARY KEY',
          'ALTER TABLE `t` ADD PRIMARY KEY (`id`)'
        ],
        catalog
      )
    ).toEqual(['in_place', 'additive']);
    expect(
      await kinds(
        [
          'ALTER TABLE `t` DROP PRIMARY KEY',
          'ALTER TABLE `t` ADD PRIMARY KEY (`id`, `other`)'
        ],
        catalog
      )
    ).toEqual(['destructive', 'additive']);
  });

  it('flags dropped and renamed tables and anything it does not recognise', async () => {
    expect(
      await kinds([
        'DROP TABLE `t`',
        'RENAME TABLE `a` TO `b`',
        'TRUNCATE TABLE `t`',
        'ALTER TABLE `t` ENGINE=MyISAM'
      ])
    ).toEqual(['destructive', 'destructive', 'destructive', 'destructive']);
  });

  it('never flags an added column or table, whatever its definition', async () => {
    await fc.assert(
      fc.asyncProperty(
        identifier,
        identifier,
        columnDefinition,
        async (table, column, definition) => {
          expect(
            await kinds([
              `CREATE TABLE \`${table}\` (\`${column}\` ${definition}) ENGINE=InnoDB`,
              `ALTER TABLE \`${table}\` ADD \`${column}\` ${definition}`
            ])
          ).toEqual(['additive', 'additive']);
        }
      )
    );
  });

  it('keeps an in-place column change in place, whatever its definition says', async () => {
    await fc.assert(
      fc.asyncProperty(
        identifier,
        identifier,
        columnDefinition,
        async (table, column, definition) => {
          expect(
            await kinds([
              `ALTER TABLE \`${table}\` CHANGE \`${column}\` \`${column}\` ${definition}`
            ])
          ).toEqual(['in_place']);
        }
      )
    );
  });

  it('always flags dropping a plain column', async () => {
    await fc.assert(
      fc.asyncProperty(identifier, identifier, async (table, column) => {
        const catalog = fakeCatalog({ plainColumns: [`${table}.${column}`] });
        expect(
          await kinds(
            [`ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``],
            catalog
          )
        ).toEqual(['destructive']);
      })
    );
  });

  it('flags any text that is not a recognised statement', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .string()
          .filter(
            (text) =>
              !/^\s*(create|drop|alter|rename|insert|update|delete)\s/i.test(
                text
              )
          ),
        async (text) => {
          expect(await kinds([text])).toEqual(['destructive']);
        }
      )
    );
  });
});

describe('destructivePlanSha256', () => {
  const drop = { query: 'ALTER TABLE `t` DROP COLUMN `c`' };
  const dropOther = { query: 'ALTER TABLE `t` DROP COLUMN `d`' };

  it('is null for a plan without destructive statements', () => {
    expect(destructivePlanSha256([])).toBeNull();
  });

  it('is a stable hex digest of the statements and their parameters', () => {
    const digest = destructivePlanSha256([drop]);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(destructivePlanSha256([{ ...drop }])).toBe(digest);
    expect(destructivePlanSha256([{ ...drop, parameters: [] }])).toBe(digest);
    expect(destructivePlanSha256([{ ...drop, parameters: [1] }])).not.toBe(
      digest
    );
    expect(destructivePlanSha256([drop, dropOther])).not.toBe(
      destructivePlanSha256([dropOther, drop])
    );
  });

  it('depends only on the destructive statements of a plan', async () => {
    const catalog = fakeCatalog({ plainColumns: ['t.c'] });
    await fc.assert(
      fc.asyncProperty(
        fc.array(identifier, { maxLength: 5 }),
        async (addedColumns) => {
          const additions = addedColumns.map((column) => ({
            query: `ALTER TABLE \`t\` ADD \`${column}\` int NULL`
          }));
          const check = await checkSchemaPlan([...additions, drop], catalog);
          expect(check.destructivePlanSha256).toBe(
            destructivePlanSha256([drop])
          );
        }
      )
    );
  });
});

describe('destructive plan decision', () => {
  const sha = 'a'.repeat(64);

  it('reads the guard mode, defaulting to report', () => {
    expect(schemaSyncDestructiveGuardMode(undefined)).toBe('report');
    expect(schemaSyncDestructiveGuardMode('')).toBe('report');
    expect(schemaSyncDestructiveGuardMode('true')).toBe('report');
    expect(schemaSyncDestructiveGuardMode(' Block ')).toBe('block');
  });

  it('accepts only a lowercase SHA-256 as an acknowledgement', () => {
    expect(isDestructivePlanAcknowledgement(sha)).toBe(true);
    expect(isDestructivePlanAcknowledgement(sha.toUpperCase())).toBe(false);
    expect(isDestructivePlanAcknowledgement(sha.slice(1))).toBe(false);
    expect(isDestructivePlanAcknowledgement(123)).toBe(false);
  });

  it.each([
    [null, 'block', null, 'none'],
    [sha, 'report', null, 'reported'],
    [sha, 'block', null, 'refused'],
    [sha, 'block', 'b'.repeat(64), 'refused'],
    [sha, 'block', sha, 'acknowledged']
  ] as const)(
    'plan %s in %s mode with acknowledgement %s is %s',
    (planSha, mode, acknowledgedSha256, decision) => {
      expect(
        destructivePlanDecision(
          { destructivePlanSha256: planSha },
          { mode, acknowledgedSha256 }
        )
      ).toBe(decision);
    }
  );
});

describe('informationSchemaCatalog', () => {
  it('reads generated columns and index uniqueness from information_schema', async () => {
    const query = jest.fn(async (sql: string, _parameters?: unknown[]) =>
      sql.includes('information_schema.COLUMNS')
        ? [{ generation_expression: 'coalesce(a, b)' }]
        : [
            { non_unique: 0, column_name: 'a' },
            { non_unique: 0, column_name: 'b' }
          ]
    );
    const catalog = informationSchemaCatalog(query);
    await expect(
      catalog.column({ schema: null, name: 't' }, 'c')
    ).resolves.toEqual({ generated: true });
    await expect(
      catalog.index({ schema: 'db', name: 't' }, 'u')
    ).resolves.toEqual({ unique: true, columns: ['a', 'b'] });
    expect(query.mock.calls.map(([, parameters]) => parameters)).toEqual([
      [null, 't', 'c'],
      ['db', 't', 'u']
    ]);
  });

  it('reports plain columns, non-unique indexes and missing objects', async () => {
    const rows: unknown[][] = [
      [{ generation_expression: '' }],
      [{ non_unique: 1, column_name: 'a' }],
      [],
      []
    ];
    const catalog = informationSchemaCatalog(async () => rows.shift());
    const table = { schema: null, name: 't' };
    await expect(catalog.column(table, 'c')).resolves.toEqual({
      generated: false
    });
    await expect(catalog.index(table, 'i')).resolves.toEqual({
      unique: false,
      columns: ['a']
    });
    await expect(catalog.column(table, 'gone')).resolves.toBeNull();
    await expect(catalog.index(table, 'gone')).resolves.toBeNull();
  });
});
