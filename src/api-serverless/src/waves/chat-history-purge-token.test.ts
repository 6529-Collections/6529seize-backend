import {
  createChatHistoryPurgeToken,
  readChatHistoryPurgeToken
} from './chat-history-purge-token';

jest.mock('@/api/auth/auth', () => ({
  getJwtSecret: () => 'test-purge-secret'
}));
const scope = { waveId: 'wave', authorId: 'author', cutoffSerialNo: 60000 };

it('retains the prepared scope for delayed retries', () => {
  const token = createChatHistoryPurgeToken(scope);
  expect(readChatHistoryPurgeToken(token, scope)).toBe(60000);
  expect(readChatHistoryPurgeToken(token, scope)).toBe(60000);
});
it.each([
  { waveId: 'other', authorId: 'author' },
  { waveId: 'wave', authorId: 'other' }
])('rejects a token reused for a different scope', (expected) => {
  expect(() =>
    readChatHistoryPurgeToken(createChatHistoryPurgeToken(scope), expected)
  ).toThrow('Invalid chat history purge token');
});
it.each(['', 'bad', 'a.b.c', 'a.'.repeat(1100)])(
  'rejects malformed tokens',
  (token) => {
    expect(() => readChatHistoryPurgeToken(token, scope)).toThrow(
      'Invalid chat history purge token'
    );
  }
);
it('rejects a modified cutoff and unsafe serial numbers', () => {
  const token = createChatHistoryPurgeToken(scope);
  const modified =
    Buffer.from(JSON.stringify({ ...scope, cutoffSerialNo: 70000 })).toString(
      'base64url'
    ) +
    '.' +
    token.split('.')[1];
  expect(() => readChatHistoryPurgeToken(modified, scope)).toThrow();
  expect(() =>
    readChatHistoryPurgeToken(
      createChatHistoryPurgeToken({
        ...scope,
        cutoffSerialNo: Number.MAX_SAFE_INTEGER + 1
      }),
      scope
    )
  ).toThrow();
});
