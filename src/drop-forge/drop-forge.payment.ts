import { getAddress, isAddress } from 'ethers';
import {
  TRANSACTIONS_TABLE,
  SUBSCRIPTIONS_REDEEMED_TABLE,
  DROP_METADATA_TABLE,
  MINTING_CLAIMS_TABLE,
  MINTING_CLAIM_ACTIONS_TABLE,
  MANIFOLD,
  NULL_ADDRESS
} from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { RequestContext } from '@/request.context';
import {
  LaunchAction,
  LaunchData,
  LaunchSafetyError
} from '@/drop-forge/drop-forge.types';
import { parseMemesMintPaymentDetails } from '@/memes-mint-stats/payment-details';
import {
  isResearchAirdrop,
  RESEARCH_DELAY_SECONDS
} from '@/drop-forge/drop-forge.research';

export async function artistPaymentQuote(
  data: LaunchData,
  total: number,
  block: number,
  ctx: RequestContext = {}
): Promise<NonNullable<LaunchAction['payment']>> {
  const manualFlag = await sqlExecutor.oneOrNull<{ completed: boolean }>(
    `SELECT completed FROM ${MINTING_CLAIM_ACTIONS_TABLE} WHERE contract = :contract AND claim_id = :claim AND action = 'PAY_ARTIST'`,
    { contract: data.contract.toLowerCase(), claim: data.claim_id },
    { wrappedConnection: ctx.connection }
  );
  if (
    manualFlag?.completed &&
    !data.manual_transactions?.some((proof) => proof.action === 'PAY_ARTIST')
  )
    throw new LaunchSafetyError(
      'Pay Artist was marked completed manually; record its transaction evidence before automatic payment'
    );
  if (
    data.actions.some(
      (it) =>
        it.kind === 'AIRDROP' &&
        !isResearchAirdrop(it) &&
        it.state !== 'CONFIRMED'
    )
  )
    throw new LaunchSafetyError(
      'Reconcile subscriber, artist and team allocations before paying the artist'
    );
  const price = data.phases[0].price_wei;
  if (data.phases.some((it) => it.price_wei !== price))
    throw new LaunchSafetyError(
      'Artist accounting requires the standard fixed mint price'
    );
  const options = { wrappedConnection: ctx.connection };
  const params = {
    contract: data.contract.toLowerCase(),
    claim: data.claim_id,
    block,
    zero: NULL_ADDRESS,
    manifold: MANIFOLD
  };
  const indexed = await sqlExecutor.oneOrNull<{ total: string; paid: string }>(
    `SELECT COALESCE(SUM(token_count), 0) AS total, COALESCE(SUM(CASE WHEN value > 0 THEN token_count ELSE 0 END), 0) AS paid FROM ${TRANSACTIONS_TABLE} WHERE contract = :contract AND token_id = :claim AND block <= :block AND from_address IN (:zero, :manifold) AND to_address NOT IN (:zero, :manifold)`,
    params,
    options
  );
  if (Number(indexed?.total) !== total)
    throw new LaunchSafetyError(
      'Mint indexing has not reconciled confirmed on-chain supply; artist payment deferred'
    );
  const subscriptions = await sqlExecutor.oneOrNull<{ count: string }>(
    `SELECT COALESCE(SUM(count), 0) AS count FROM ${SUBSCRIPTIONS_REDEEMED_TABLE} WHERE contract = :contract AND token_id = :claim`,
    params,
    options
  );
  const subscriptionCount = Number(subscriptions?.count ?? 0);
  const expectedSubscriptions = data.actions
    .filter((it) => it.kind === 'AIRDROP' && it.label?.includes('Subscription'))
    .reduce(
      (n, it) => n + it.recipients.reduce((sum, row) => sum + row.amount, 0),
      0
    );
  const paid = Number(indexed?.paid ?? 0);
  if (
    !Number.isSafeInteger(paid) ||
    paid < 0 ||
    !Number.isSafeInteger(subscriptionCount) ||
    subscriptionCount !== expectedSubscriptions ||
    paid + subscriptionCount > total
  )
    throw new LaunchSafetyError(
      'Artist payment accounting is incomplete or inconsistent with the launch'
    );
  const row = await sqlExecutor.oneOrNull<{ payment_details: string }>(
    `SELECT dm.data_value AS payment_details FROM ${MINTING_CLAIMS_TABLE} mc JOIN ${DROP_METADATA_TABLE} dm ON dm.drop_id = mc.drop_id AND dm.data_key = 'payment_info' WHERE mc.contract = :contract AND mc.claim_id = :claim ORDER BY dm.id DESC LIMIT 1`,
    params,
    options
  );
  const payee = parseMemesMintPaymentDetails(
    row?.payment_details
  )?.payment_address.trim();
  if (
    !payee ||
    !isAddress(payee) ||
    /^0x0{40}$/i.test(payee) ||
    payee.toLowerCase() === data.signer.toLowerCase()
  )
    throw new LaunchSafetyError(
      'Artist payment requires a valid designated payment address'
    );
  return {
    recipient: getAddress(payee),
    amount_wei: (
      (BigInt(paid + subscriptionCount) * BigInt(price)) /
      BigInt(2)
    ).toString(),
    paid_count: paid,
    subscriptions_count: subscriptionCount
  };
}

export function verifyPaymentTiming(
  data: LaunchData,
  action: LaunchAction,
  now: number
): void {
  if (
    action.due !== data.phases.at(-1)!.end + RESEARCH_DELAY_SECONDS ||
    now < action.due
  )
    throw new LaunchSafetyError(
      'Artist payment is eligible one hour after public minting closes'
    );
}

export function assertPaymentQuote(
  action: LaunchAction,
  quote: NonNullable<LaunchAction['payment']>,
  capture: boolean
): void {
  if (!action.payment && capture) action.payment = quote;
  if (
    !action.payment ||
    action.payment.recipient !== quote.recipient ||
    action.payment.amount_wei !== quote.amount_wei
  )
    throw new LaunchSafetyError(
      'Artist payment details changed; reconcile the frozen payout before proceeding'
    );
}
