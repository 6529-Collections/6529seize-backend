import {
  dropForgePreparationRepository,
  resetDistributionPreparation
} from '@/drop-forge/drop-forge.preparation.repository';
import type { RequestContext } from '@/request.context';
import { sqlExecutor } from '@/sql-executor';
import {
  MintLogRecorder,
  mintLogRecorder,
  MintWriteSpec
} from './mint-log-recorder';

type PreparationStart = Parameters<
  typeof dropForgePreparationRepository.run
>[6];

/**
 * A logged write to a card's distribution that runs under Drop Forge's
 * preparation lock. The log goes inside the preparation's transaction,
 * after its locks: the preparation first, then the mint log's head, the
 * order every path takes, so a long Drop Forge step never holds up other
 * mint writes behind the head. The entry's "before" rows are read once the
 * preparation is held, and the transaction is READ COMMITTED, so they
 * include whatever committed while it waited. The writer, Drop Forge's
 * state and the entry commit or roll back together.
 */
export async function loggedPreparationWrite<T>(args: {
  readonly spec: MintWriteSpec<T>;
  readonly contract: string;
  readonly claim: number;
  readonly write: (ctx: RequestContext) => Promise<T>;
  readonly ctx?: RequestContext;
  readonly start?: PreparationStart;
  readonly recorder?: MintLogRecorder;
}): Promise<T> {
  const recorder = args.recorder ?? mintLogRecorder;
  return sqlExecutor.executeNativeQueriesInTransaction(
    (connection) =>
      dropForgePreparationRepository.run(
        args.contract,
        args.claim,
        (_, txCtx) =>
          recorder.writeWithin(args.spec, connection, () => args.write(txCtx)),
        { ...args.ctx, connection },
        false,
        false,
        args.start
      ),
    { isolationLevel: 'READ COMMITTED' }
  );
}

/**
 * A logged reset of a card's distribution, inside Drop Forge's reset: its
 * checks (a job finishing a step answers 409) come before the mint log's
 * head is taken, and the reset, Drop Forge's state and the entry commit or
 * roll back together. The lock order and isolation are as in
 * loggedPreparationWrite.
 */
export async function loggedPreparationReset(args: {
  readonly spec: MintWriteSpec<void>;
  readonly contract: string;
  readonly claim: number;
  readonly reset: (ctx: RequestContext) => Promise<void>;
  readonly ctx?: RequestContext;
  readonly recorder?: MintLogRecorder;
}): Promise<void> {
  const recorder = args.recorder ?? mintLogRecorder;
  await sqlExecutor.executeNativeQueriesInTransaction(
    (connection) =>
      resetDistributionPreparation(
        args.contract,
        args.claim,
        (txCtx) =>
          recorder.writeWithin(args.spec, connection, () => args.reset(txCtx)),
        { ...args.ctx, connection }
      ),
    { isolationLevel: 'READ COMMITTED' }
  );
}
