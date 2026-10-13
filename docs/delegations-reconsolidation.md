# On-demand staging reconsolidation

The existing `delegationsLoop` Lambda accepts a permanent maintenance action:

```json
{
  "action": "reconsolidate",
  "wallets": ["0x3c8a67ff9d751c3cce50c9acf617959396daacd3"]
}
```

Invoke it synchronously using the existing AWS Lambda invocation permissions.
This action is restricted to the deployment-owned
`SENTRY_ENVIRONMENT=delegationsLoop_staging` runtime marker. It is not an HTTP
endpoint, and no persistent flag enables or repeats it. Production invocations
of this action fail before connecting to the database.

Supply 1–100 valid, nonzero Ethereum addresses. Addresses are normalized and
deduplicated. Invalid actions, invalid addresses, missing/empty wallet lists,
and wallet lists without an explicit action fail instead of indexing normally.
An invocation cannot combine this action with the expiry/token-scope backfill
flag; remove that flag first.

The requested wallets are seeds: include a member of each group to refresh.
The Lambda expands them through the previous persisted TDH groups and current
confirmed consolidation groups. Both chain-event processing and this action
use the same reconsolidation function, in the same order:

1. Recalculate affected wallets' TDH at the latest UTC midnight.
2. Persist partial consolidated TDH and reconcile identities/profiles. The
   existing partial TDH path also queues the asynchronous xTDH universe refresh.
3. Rebuild consolidated NFT ownership, owner balances, and activity.
4. Reconcile subscription records.
5. For the maintenance action, update primary addresses for all affected wallets.

The successful response and logs include `action`, `status=completed`,
`requested_wallets`, `affected_wallets`, and the calculation `block`. Success
means all synchronous steps completed; the queued xTDH work runs separately.
If a step fails, the invocation fails and later steps do not run. The entire
pipeline is not one database transaction; inspect the failed step before retrying.

This invocation does not scan Ethereum delegation events, discover ENS names,
persist new registration/revocation events, or advance `nftdelegation_blocks`.
It ignores the normal `DELEGATIONS_RESET_BLOCK` scanning option. Ordinary
scheduled invocations without an action continue indexing normally. This action
recalculates existing data; it does not insert test links or change the activation
policy.

Deploy only `delegationsLoop` to make this handler change available. No schema,
API contract, IAM policy, schedule, or queue configuration change is required.
