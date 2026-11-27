import {
  MINTING_MERKLE_PROOFS_TABLE,
  MINTING_MERKLE_ROOTS_TABLE
} from '@/constants';
import { ConnectionWrapper, dbSupplier, SqlExecutor } from '@/sql-executor';
import {
  MintColumn,
  MintColumnCatalog,
  quoteIdentifier,
  writeExpression
} from './mint-log-columns';
import { expandMerkleRoot } from './mint-log-merkle';
import {
  cardParams,
  MINT_ROW_PART_SPECS,
  MintRowPartSpec
} from './mint-log-parts';
import {
  MINT_ROW_PARTS,
  MintCardEffects,
  MintCardRef,
  MintMerkleDiff,
  MintRow,
  MintRowDiff
} from './mint-log.types';

const BATCH = 200;

/**
 * The reducer: writes an entry's effects to the tables. The live replay check
 * and the rebuild both use it, so a rebuild runs the code the check exercises
 * on every write.
 */
/** The log and the tables disagree: an update found no row, or several. */
export class MintApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MintApplyError';
    Object.setPrototypeOf(this, MintApplyError.prototype);
  }
}

export class MintStateWriter {
  constructor(
    private readonly db: () => SqlExecutor = dbSupplier,
    private readonly catalog: MintColumnCatalog = new MintColumnCatalog(db)
  ) {}

  async apply(
    card: MintCardRef,
    effects: MintCardEffects,
    connection: ConnectionWrapper<any>
  ): Promise<void> {
    for (const part of MINT_ROW_PARTS) {
      const diff = effects[part];
      if (diff) {
        await this.applyRows(MINT_ROW_PART_SPECS[part], card, diff, connection);
      }
    }
    if (effects.merkle) {
      await this.applyMerkle(card, effects.merkle, connection);
    }
  }

  /** Writes one part's rows by its spec (also used for genesis-pinned columns). */
  async applyRows(
    spec: MintRowPartSpec,
    card: MintCardRef,
    diff: MintRowDiff,
    connection: ConnectionWrapper<any>
  ): Promise<void> {
    if (spec.mode === 'update-only') {
      await this.updateOnly(spec, card, diff, connection);
    } else {
      await this.deleteRows(spec, diff.delete, connection);
      await this.upsertRows(spec, diff.upsert, connection);
    }
  }

  /** Deletes by key, a batch of rows per statement. */
  private async deleteRows(
    spec: MintRowPartSpec,
    keys: readonly MintRow[],
    connection: ConnectionWrapper<any>
  ): Promise<void> {
    const columns = `(${spec.key.map(quoteIdentifier).join(', ')})`;
    for (let start = 0; start < keys.length; start += BATCH) {
      const params: Record<string, unknown> = {};
      const tuples = keys.slice(start, start + BATCH).map(
        (key, i) =>
          `(${spec.key
            .map((column) => {
              params[`k${i}_${column}`] = key[column] ?? null;
              return `:k${i}_${column}`;
            })
            .join(', ')})`
      );
      await this.db().execute(
        `delete from ${quoteIdentifier(spec.table)}
         where ${columns} in (${tuples.join(', ')})`,
        params,
        { wrappedConnection: connection }
      );
    }
  }

  private async upsertRows(
    spec: MintRowPartSpec,
    rows: readonly MintRow[],
    connection: ConnectionWrapper<any>
  ): Promise<void> {
    if (!rows.length) return;
    const logged = await this.catalog.columns(
      spec.table,
      spec.excluded,
      connection
    );
    const loggedNames = new Set(logged.map((column) => column.name));
    const defaults = spec.insertDefaults
      ? Object.keys(spec.insertDefaults({}))
      : [];
    const insertColumns: MintColumn[] = [
      ...logged,
      ...(await this.catalog.columns(spec.table, [], connection)).filter(
        (column) =>
          defaults.includes(column.name) && !loggedNames.has(column.name)
      )
    ];
    const updates = logged
      .filter((column) => !spec.key.includes(column.name))
      .map((column) => {
        const id = quoteIdentifier(column.name);
        return `${id} = VALUES(${id})`;
      });
    const onDuplicate = updates.length
      ? updates.join(', ')
      : spec.key
          .map((column) => {
            const id = quoteIdentifier(column);
            return `${id} = ${id}`;
          })
          .join(', ');
    for (let start = 0; start < rows.length; start += BATCH) {
      const chunk = rows.slice(start, start + BATCH);
      const params: Record<string, unknown> = {};
      const values = chunk.map((row, i) => {
        const filled: Record<string, unknown> = {
          ...(spec.insertDefaults ? spec.insertDefaults(row) : {}),
          ...row
        };
        return `(${insertColumns
          .map((column) => {
            const param = `r${i}_${column.name}`;
            params[param] = filled[column.name] ?? null;
            return writeExpression(column, param);
          })
          .join(', ')})`;
      });
      await this.db().execute(
        `insert into ${quoteIdentifier(spec.table)}
           (${insertColumns.map((column) => quoteIdentifier(column.name)).join(', ')})
         values ${values.join(', ')}
         on duplicate key update ${onDuplicate}`,
        params,
        { wrappedConnection: connection }
      );
    }
  }

  private async updateOnly(
    spec: MintRowPartSpec,
    card: MintCardRef,
    diff: MintRowDiff,
    connection: ConnectionWrapper<any>
  ): Promise<void> {
    const columns = (
      await this.catalog.columns(spec.table, spec.excluded, connection)
    )
      .filter((column) => spec.only?.includes(column.name) ?? true)
      .filter((column) => !spec.key.includes(column.name));
    for (const row of diff.upsert) {
      const params: Record<string, unknown> = cardParams(card);
      const sets = columns.map((column) => {
        params[`v_${column.name}`] = row[column.name] ?? null;
        return `${quoteIdentifier(column.name)} = ${writeExpression(column, `v_${column.name}`)}`;
      });
      const keys = spec.key.map((column) => {
        params[`k_${column}`] = row[column] ?? null;
        return `${quoteIdentifier(column)} = :k_${column}`;
      });
      const result = await this.db().execute(
        `update ${quoteIdentifier(spec.table)} set ${sets.join(', ')}
         where ${spec.scope} and ${keys.join(' and ')}`,
        params,
        { wrappedConnection: connection }
      );
      // The rows belong to another writer; one that is missing means the
      // tables disagree with the log, and a rebuild must not go on quietly.
      const matched = this.db().getAffectedRows(result);
      if (matched !== 1) {
        const where = spec.key
          .map((column) => `${column} ${String(row[column])}`)
          .join(', ');
        // The legacy subscription tables' rebuild creates the final rows; a
        // mint log rebuild run before it finds none.
        const hint =
          spec.part === 'subscription_phases' && matched === 0
            ? "; the legacy subscription tables' rebuild creates these rows and must run before the mint log rebuild"
            : '';
        throw new MintApplyError(
          `${spec.table} row ${where} matched ${matched} rows, not 1${hint}`
        );
      }
    }
  }

  private async applyMerkle(
    card: MintCardRef,
    diff: MintMerkleDiff,
    connection: ConnectionWrapper<any>
  ): Promise<void> {
    const phases = [
      ...diff.delete,
      ...diff.upsert.map((root) => String(root.row.phase))
    ];
    for (const phase of phases) {
      // As the distribution writer does: a phase's old proofs go with its root.
      await this.db().execute(
        `delete from ${quoteIdentifier(MINTING_MERKLE_PROOFS_TABLE)}
         where merkle_root in (
           select merkle_root from (
             select merkle_root from ${quoteIdentifier(MINTING_MERKLE_ROOTS_TABLE)}
             where contract = :contract and card_id = :card_id and phase = :phase
           ) as phase_roots
         )`,
        { contract: card.contract, card_id: card.card_id, phase },
        { wrappedConnection: connection }
      );
      await this.db().execute(
        `delete from ${quoteIdentifier(MINTING_MERKLE_ROOTS_TABLE)}
         where contract = :contract and card_id = :card_id and phase = :phase`,
        { contract: card.contract, card_id: card.card_id, phase },
        { wrappedConnection: connection }
      );
    }
    const rootColumns = await this.catalog.columns(
      MINTING_MERKLE_ROOTS_TABLE,
      [],
      connection
    );
    for (const root of diff.upsert) {
      const params: Record<string, unknown> = {};
      const values = rootColumns.map((column) => {
        params[column.name] = root.row[column.name] ?? null;
        return writeExpression(column, column.name);
      });
      await this.db().execute(
        `insert into ${quoteIdentifier(MINTING_MERKLE_ROOTS_TABLE)}
           (${rootColumns.map((column) => quoteIdentifier(column.name)).join(', ')})
         values (${values.join(', ')})`,
        params,
        { wrappedConnection: connection }
      );
      const proofs = expandMerkleRoot(root);
      for (let start = 0; start < proofs.length; start += BATCH) {
        const chunk = proofs.slice(start, start + BATCH);
        const proofParams: Record<string, unknown> = {};
        const rows = chunk.map((proof, i) => {
          proofParams[`m${i}`] = proof.merkle_root;
          proofParams[`a${i}`] = proof.address;
          proofParams[`p${i}`] = proof.proofs;
          return `(:m${i}, :a${i}, :p${i})`;
        });
        await this.db().execute(
          `insert into ${quoteIdentifier(MINTING_MERKLE_PROOFS_TABLE)}
             (merkle_root, address, proofs)
           values ${rows.join(', ')}`,
          proofParams,
          { wrappedConnection: connection }
        );
      }
    }
  }
}

export const mintStateWriter = new MintStateWriter();
