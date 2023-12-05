import {
  ConnectionWrapper,
  LazyDbAccessCompatibleService
} from '../sql-executor';
import { Mock, mock } from 'ts-jest-mocker';
import { when } from 'jest-when';

export async function expectExceptionWithMessage(
  scenario: () => unknown,
  message: string
) {
  try {
    await scenario();
    throw new Error(
      `Expected an exception with message ${message}, but it never happened`
    );
  } catch (e: any) {
    expect(e?.message).toBe(message);
  }
}

export function mockDbService<T extends LazyDbAccessCompatibleService>(
  clazz?: new (...args: any[]) => T
): Mock<T> {
  const mocked = mock(clazz);
  when(mocked.executeNativeQueriesInTransaction).mockImplementation(
    async (lambda) => await lambda({ connection: {} })
  );
  return mocked;
}

export const mockConnection: ConnectionWrapper<any> = {
  connection: {}
};
