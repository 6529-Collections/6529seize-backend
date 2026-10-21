import { CompetitionExecutionRouter } from '@/competitions/competition-execution.router';
import {
  CompetitionExecutionMode,
  CompetitionStorageMode
} from '@/entities/ICompetition';

const router = new CompetitionExecutionRouter();

it.each(Object.values(CompetitionStorageMode))(
  'executes only active native competition storage: %s',
  (storage_mode) => {
    expect(
      router.isNativeExecutionAllowed({
        storage_mode,
        execution_mode: CompetitionExecutionMode.ACTIVE
      })
    ).toBe(storage_mode === CompetitionStorageMode.NATIVE);
  }
);

it.each([CompetitionExecutionMode.DISABLED, CompetitionExecutionMode.SHADOW])(
  'does not execute %s competitions',
  (execution_mode) => {
    expect(
      router.isNativeExecutionAllowed({
        storage_mode: CompetitionStorageMode.NATIVE,
        execution_mode
      })
    ).toBe(false);
  }
);
