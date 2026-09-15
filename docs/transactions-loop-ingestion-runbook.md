# Transactions Loop Ingestion Runbook

## Why ingestion fails closed

`transactionsLoop` verifies mappable Alchemy transfers before saving them:

- every transfer must have a non-blank Alchemy `uniqueId`;
- token counts must agree with the transaction receipt; and
- every mapped NFT transfer must have a matching receipt log with a safe count;
  legitimate zero-value ERC-1155 initialization transfers remain indexed with
  `token_count = 0`.

A failed verification rejects the whole batch. This deliberately prevents the
contract checkpoint from advancing past an unverified transfer. Skipping or
quarantining a transfer without a durable replay checkpoint could silently lose
it when the next invocation starts from the latest saved block.

Receipt verification reuses the transaction and receipt requests already made
by value resolution. It adds no database queries and no additional receipt RPC
requests.

## Alerting

Each production function has a one-minute CloudWatch `AWS/Lambda` `Errors`
alarm:

- `memesTransactionsLoop`
- `gradientsTransactionsLoop`
- `memeLabTransactionsLoop`

The alarms publish to the existing `cloudwatch-alarms` SNS topic and Discord
notification path. The wrapped Lambda handler also reports the original error
to the function-specific Sentry environment.

## Triage and recovery

1. Identify the failing function, transaction hash, contract, token, and block
   from Sentry or CloudWatch logs.
2. Compare the Alchemy transfer response with the canonical transaction
   receipt. Check whether the failure is transient provider unavailability,
   a missing `uniqueId`, a missing matching NFT log, or an unsafe token count.
3. For a transient provider failure, let the scheduled loop retry. It runs
   every minute and resumes from the unchanged database checkpoint.
4. For a persistent mismatch, do not skip the transfer or manually advance the
   checkpoint. Verify the canonical receipt first, then repair the affected
   transaction through the controlled custom replay workflow.
5. Confirm the corrected raw and consolidated ownership balances, rerun
   downstream TDH calculation when historical ownership changed, and verify the
   loop advances beyond the affected block.

If the alarm remains active after provider recovery or a controlled repair,
escalate with the function name, contract, block, transaction hash, and both
the indexed and receipt representations.
