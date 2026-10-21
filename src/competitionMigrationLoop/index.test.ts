jest.mock('@/sentry.context', () => ({
  wrapLambdaHandler: (handler: unknown) => handler
}));
import { handleMigration } from './index';

it('acknowledges all pending migrations without opening a database or continuing work', async () => {
  await expect(handleMigration()).resolves.toEqual({
    status: 'RETIRED',
    message: 'Legacy competition migration is retired'
  });
});
