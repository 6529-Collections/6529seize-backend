import { Column, Entity, PrimaryColumn } from 'typeorm';
import { WAVES_SETTLEMENT_SENDS_TABLE } from '@/constants';

/**
 * The last SETTLEMENT_REQUEST 6529.io's backend sent for each decision on
 * the 6529 chain (src/waves-settlement). It keeps the sender from sending
 * twice for one step of a count while its transaction may still run.
 *
 * - `occurrence` and `count_next` name the step: the decision's next
 *   occurrence and its count's `next` (null before the count starts).
 * - `nonce_lane` is the sender wallet's nonce lane (0 to 15), derived from
 *   the decision id, so every request for a decision, from any sender with
 *   the same key, takes the same lane and nonce and only one executes.
 * - `attempts`: tries for this step (drafts, refusals, lost submits and
 *   failures alike), which set the wait before the next; `failures`: the
 *   requests for this step that failed in a block and paid their fee, which
 *   end the tries. A new step starts both again at 0.
 * - `status`: `submitting` (saved before the submit, so a submit whose
 *   answer is lost is still checked), `submitted`, `refused`, `error`,
 *   `given_up` (no request for this step for a few hours), `not_yet`
 *   (the chain's waves import was running: tried again on the next run),
 *   `not_included` (it expired and no block held it; `last_error` says
 *   how many in a row), or the transaction's state as the gateway last gave
 *   it (`pending`, `in_block`, `final`, `failed`, `unknown`).
 */
@Entity(WAVES_SETTLEMENT_SENDS_TABLE)
export class WavesSettlementSendEntity {
  @PrimaryColumn({ type: 'varchar', length: 66 })
  readonly decision_id!: string;

  @Column({ type: 'bigint' })
  readonly occurrence!: number;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly count_next!: number | null;

  @Column({ type: 'int' })
  readonly nonce_lane!: number;

  @Column({ type: 'int', default: 0 })
  readonly attempts!: number;

  @Column({ type: 'int', default: 0 })
  readonly failures!: number;

  @Column({ type: 'varchar', length: 66, nullable: true, default: null })
  readonly tx_id!: string | null;

  /** Unix ms. */
  @Column({ type: 'bigint' })
  readonly sent_at!: number;

  @Column({ type: 'varchar', length: 16 })
  readonly status!: string;

  @Column({ type: 'text', nullable: true, default: null })
  readonly last_error!: string | null;

  /** Unix ms. */
  @Column({ type: 'bigint' })
  readonly updated_at!: number;
}
