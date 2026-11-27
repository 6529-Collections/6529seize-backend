import {
  MINTING_MERKLE_PROOFS_TABLE,
  MINTING_MERKLE_ROOTS_TABLE
} from '@/constants';
import { ConnectionWrapper, dbSupplier, SqlExecutor } from '@/sql-executor';
import {
  MintColumnCatalog,
  quoteIdentifier,
  selectExpression
} from './mint-log-columns';
import { compactMerkleRoot, MintProofRow } from './mint-log-merkle';
import { subscriptionsIdentitySwitch } from '@/subscriptions-identity/identity/identity-switch';
import {
  cardParams,
  compareText,
  MINT_ROW_PART_SPECS,
  MintRowPartSpec,
  partApplies,
  sortRows
} from './mint-log-parts';
import {
  MINT_ROW_PARTS,
  MintCardRef,
  MintCardState,
  MintMerkleRoot,
  MintRow,
  MintRowPart
} from './mint-log.types';

/** What one logged write already knows when it captures a card. */
export interface MintCaptureOptions {
  /** The switch's answer for the write (identityTruthFor). */
  readonly identityTruth?: boolean;
}

/** Reads everything the minting tables hold for one card, in logged form. */
export class MintStateReader {
  constructor(
    private readonly db: () => SqlExecutor = dbSupplier,
    private readonly catalog: MintColumnCatalog = new MintColumnCatalog(db),
    /**
     * Whether the subscriptions switch names the identity tables now, read
     * uncached, as the phase pulls read it to choose the tables they write.
     */
    private readonly identitySubscriptionsAreTruth: () => Promise<boolean> = async () =>
      (await subscriptionsIdentitySwitch.writeModeOrFail()) === 'TRUTH'
  ) {}

  /**
   * The switch's answer for one logged write, read once and given to each of
   * its captures, so they all agree even if go-live commits in between.
   * Undefined for a card no identity subscriptions part applies to.
   */
  async identityTruthFor(card: MintCardRef): Promise<boolean | undefined> {
    const applies = MINT_ROW_PARTS.some((part) => {
      const spec = MINT_ROW_PART_SPECS[part];
      return spec.identitySubscriptions && partApplies(spec, card);
    });
    return applies ? this.identitySubscriptionsAreTruth() : undefined;
  }

  /**
   * `options.identityTruth` is the write's answer from identityTruthFor;
   * without it (a genesis, a rebuild) the switch is read here, once.
   */
  async capture(
    card: MintCardRef,
    connection: ConnectionWrapper<any>,
    options: MintCaptureOptions = {}
  ): Promise<MintCardState> {
    let identityTruth = options.identityTruth;
    const rows = {} as Record<MintRowPart, MintRow[]>;
    for (const part of MINT_ROW_PARTS) {
      const spec = MINT_ROW_PART_SPECS[part];
      if (spec.identitySubscriptions && partApplies(spec, card)) {
        identityTruth ??= await this.identitySubscriptionsAreTruth();
        if (!identityTruth) {
          rows[part] = [];
          continue;
        }
      }
      rows[part] = await this.captureRows(spec, card, connection);
    }
    const merkle = await this.captureMerkle(card, connection);
    return { ...rows, merkle };
  }

  async columnsOf(spec: MintRowPartSpec, connection: ConnectionWrapper<any>) {
    const columns = await this.catalog.columns(
      spec.table,
      spec.excluded,
      connection
    );
    return spec.only
      ? columns.filter((column) => spec.only!.includes(column.name))
      : columns;
  }

  private async captureRows(
    spec: MintRowPartSpec,
    card: MintCardRef,
    connection: ConnectionWrapper<any>
  ): Promise<MintRow[]> {
    if (!partApplies(spec, card)) return [];
    const columns = await this.columnsOf(spec, connection);
    const rows = await this.db().execute<MintRow>(
      `select ${columns.map(selectExpression).join(', ')}
       from ${quoteIdentifier(spec.table)}
       where ${spec.scope}`,
      cardParams(card),
      { wrappedConnection: connection }
    );
    return sortRows(spec, rows.map(normalizeRow));
  }

  private async captureMerkle(
    card: MintCardRef,
    connection: ConnectionWrapper<any>
  ): Promise<MintMerkleRoot[]> {
    const columns = await this.catalog.columns(
      MINTING_MERKLE_ROOTS_TABLE,
      [],
      connection
    );
    const roots = (
      await this.db().execute<MintRow>(
        `select ${columns.map(selectExpression).join(', ')}
         from ${quoteIdentifier(MINTING_MERKLE_ROOTS_TABLE)}
         where contract = :contract and card_id = :card_id`,
        { contract: card.contract, card_id: card.card_id },
        { wrappedConnection: connection }
      )
    ).map(normalizeRow);
    if (!roots.length) return [];
    const proofs = await this.db().execute<MintProofRow>(
      `select merkle_root, address, CAST(proofs AS CHAR) as proofs
       from ${quoteIdentifier(MINTING_MERKLE_PROOFS_TABLE)}
       where merkle_root in (:roots)`,
      { roots: Array.from(new Set(roots.map((root) => root.merkle_root))) },
      { wrappedConnection: connection }
    );
    return roots
      .map((root) =>
        compactMerkleRoot(
          root,
          proofs.filter((proof) => proof.merkle_root === root.merkle_root)
        )
      )
      .sort((a, b) => compareText(String(a.row.phase), String(b.row.phase)));
  }
}

/**
 * The driver returns plain objects; booleans can only come from columns this
 * module does not cast, so they become numbers to keep one JSON form.
 */
function normalizeRow(row: Record<string, unknown>): MintRow {
  const out: Record<string, string | number | null> = {};
  for (const [name, value] of Object.entries(row)) {
    if (value === null || value === undefined) out[name] = null;
    else if (typeof value === 'boolean') out[name] = value ? 1 : 0;
    else if (typeof value === 'number' || typeof value === 'string')
      out[name] = value;
    else out[name] = JSON.stringify(value);
  }
  return out;
}

export const mintStateReader = new MintStateReader();
