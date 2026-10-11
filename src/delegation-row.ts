import { Delegation, DelegationEvent } from '@/entities/IDelegation';
import { LessThan, MoreThanOrEqual, Repository } from 'typeorm';

/** Largest token id the delegations.token_id column (signed INT) can hold. */
export const MAX_STORABLE_DELEGATION_TOKEN_ID = BigInt(2_147_483_647);

const SAVE_CHUNK_SIZE = 500;

/**
 * Builds the stored row for a delegation registration. Values the event does
 * not carry are left unset so the column defaults apply (never expires, all
 * tokens, token 0). A token-specific registration keeps all_tokens = false
 * and its token id.
 */
export function toDelegationRow(registration: DelegationEvent): Delegation {
  const row = new Delegation();
  row.block = registration.block;
  row.from_address = registration.wallet1;
  row.to_address = registration.wallet2;
  row.collection = registration.collection;
  row.use_case = registration.use_case;
  if (registration.expiry !== undefined) {
    row.expiry = registration.expiry;
  }
  if (registration.all_tokens !== undefined) {
    row.all_tokens = registration.all_tokens;
  }
  if (registration.token_id !== undefined) {
    row.token_id = registration.token_id;
  }
  return row;
}

/**
 * Applies one scan's delegation changes: the replay delete (when
 * `startBlock` is set), then the registrations, then the revocations. Run it
 * inside a transaction, so a failure part-way through cannot leave the
 * replay delete or some rows applied without the rest.
 */
export async function writeDelegations(
  repo: Repository<Delegation>,
  startBlock: number | undefined,
  registrations: DelegationEvent[],
  revocations: DelegationEvent[]
): Promise<void> {
  if (startBlock) {
    await repo.delete({ block: MoreThanOrEqual(startBlock) });
  }
  const rows = latestRowPerKey(registrations.map(toDelegationRow));
  if (rows.length > 0) {
    await repo.save(rows, { chunk: SAVE_CHUNK_SIZE });
  }
  // A revocation removes the pair's registrations from earlier blocks. The
  // deletes do not depend on each other, and the transaction's connection
  // runs them one at a time.
  await Promise.all(
    revocations.map((revocation) =>
      repo.delete({
        from_address: revocation.wallet1,
        to_address: revocation.wallet2,
        use_case: revocation.use_case,
        collection: revocation.collection,
        block: LessThan(revocation.block)
      })
    )
  );
}

// Several registrations can share the table key (block, from, to,
// collection, use case), for example two token-specific batch items for one
// delegate. Saving them in one call would insert the key twice, so only the
// last one in log order is kept, as when each row was saved on its own.
function latestRowPerKey(rows: Delegation[]): Delegation[] {
  const byKey = new Map<string, Delegation>();
  for (const row of rows) {
    const key = [
      row.block,
      row.from_address.toLowerCase(),
      row.to_address.toLowerCase(),
      row.collection.toLowerCase(),
      row.use_case
    ].join('|');
    byKey.delete(key);
    byKey.set(key, row);
  }
  return Array.from(byKey.values());
}
