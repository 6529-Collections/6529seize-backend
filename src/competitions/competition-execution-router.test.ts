import { CompetitionExecutionRouter } from '@/competitions/competition-execution.router';
import { CompetitionExecutionMode } from '@/entities/ICompetition';

const router = new CompetitionExecutionRouter();

it.each([
  [CompetitionExecutionMode.ACTIVE, true],
  [CompetitionExecutionMode.DISABLED, false]
])(
  'enforces execution mode %s independently of storage',
  (execution_mode, expected) => {
    expect(router.isNativeExecutionAllowed({ execution_mode })).toBe(expected);
  }
);
