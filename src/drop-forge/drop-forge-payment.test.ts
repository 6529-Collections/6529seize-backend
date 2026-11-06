import { sqlExecutor } from '@/sql-executor';
import {
  artistPaymentQuote,
  assertPaymentQuote,
  verifyPaymentTiming
} from '@/drop-forge/drop-forge.payment';
import { testLaunchData } from '@/drop-forge/drop-forge.test-fixtures';
import { RESEARCH_DELAY_SECONDS } from '@/drop-forge/drop-forge.research';

jest.mock('@/sql-executor', () => ({
  ...jest.requireActual<typeof import('@/sql-executor')>('@/sql-executor'),
  sqlExecutor: { oneOrNull: jest.fn() }
}));
beforeEach(() => jest.mocked(sqlExecutor.oneOrNull).mockReset());

const recipient = '0x' + '66'.repeat(20);
function fixture() {
  const data = testLaunchData();
  for (const action of data.actions)
    if (action.kind === 'AIRDROP') action.state = 'CONFIRMED';
  const action = data.actions.find((it) => it.kind === 'PAY_ARTIST')!;
  const read = jest
    .spyOn(sqlExecutor, 'oneOrNull')
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({ total: '10', paid: '3' })
    .mockResolvedValueOnce({ count: '1' })
    .mockResolvedValueOnce({
      payment_details: JSON.stringify({
        payment_address: recipient,
        has_designated_payee: true
      })
    });
  return { data, action, read };
}
it('uses exact wei and the existing 50% split across paid mints and subscriptions', async () => {
  const { data } = fixture();
  expect(await artistPaymentQuote(data, 10, 100)).toEqual({
    recipient,
    amount_wei: '200',
    paid_count: 3,
    subscriptions_count: 1
  });
});
it('waits for confirmed mint indexing rather than paying an incomplete total', async () => {
  const { data } = fixture();
  await expect(artistPaymentQuote(data, 11, 100)).rejects.toThrow('indexing');
});
it('does not trust a manually completed checkbox without transaction evidence', async () => {
  const { data, read } = fixture();
  read.mockReset().mockResolvedValueOnce({ completed: true });
  await expect(artistPaymentQuote(data, 10, 100)).rejects.toThrow(
    'transaction evidence'
  );
});
it('rejects payment-source changes after the amount and recipient are frozen', () => {
  const { action } = fixture();
  const quote = {
    recipient,
    amount_wei: '200',
    paid_count: 3,
    subscriptions_count: 1
  };
  assertPaymentQuote(action, quote, true);
  expect(() =>
    assertPaymentQuote(action, { ...quote, amount_wei: '201' }, false)
  ).toThrow('changed');
  expect(() =>
    assertPaymentQuote(
      action,
      { ...quote, recipient: '0x' + '77'.repeat(20) },
      false
    )
  ).toThrow('changed');
});
it('groups payment with Research one hour after mint close and refuses earlier execution', () => {
  const { data, action } = fixture();
  expect(action.due).toBe(data.phases.at(-1)!.end + RESEARCH_DELAY_SECONDS);
  expect(RESEARCH_DELAY_SECONDS).toBe(3600);
  expect(() => verifyPaymentTiming(data, action, action.due - 1)).toThrow(
    'one hour'
  );
  expect(() => verifyPaymentTiming(data, action, action.due)).not.toThrow();
});

afterEach(() => jest.restoreAllMocks());
