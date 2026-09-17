# Membership runtime deployment controls

Membership source tracking, background processing, and API reads are separate
deployment controls. The `Deploy a service` workflow defaults them to
`inactive`, `inactive` with both triggers disabled, and `legacy`/`off`,
respectively. Production rejects active values. A normal deployment does not
start membership processing or change API read behavior.

| Control | Staging value | Deployment unit |
| --- | --- | --- |
| `membership_source_tracking_mode` | `tracking-v1` | Each producer service, including `api` |
| `membership_runtime_mode` | `staging-controlled-v1` | `membershipRefreshLoop` and `membershipRefreshDispatcherLoop` |
| `membership_worker_mapping_enabled` | `true` | `membershipRefreshLoop` |
| `membership_dispatch_schedule_enabled` | `true` | `membershipRefreshDispatcherLoop` |
| `membership_read_mode`, `membership_shadow_mode` | `staging-controlled-v1` | `api` |

These values are explicit per deployment. An omitted control resets that
service to its inactive default. `tracking-v1` is a staging-only source-write
gate and does not provision source evidence. Tracked writes require an audited,
provisioned source key; absent evidence fails the transaction. During a rollout
where any writer path is still inactive, no source coverage/readiness receipt
can be claimed. The controlled worker status reports source readiness as
`unverified` because deployment settings cannot establish coverage.

The target table is the durable backlog while processing is inactive. Its
primary key is `(scope, target_id)`, so repeated requests for the same
PROFILE, GROUP, or FULL target increment one row's version and move its due
time forward. Distinct targets still consume distinct rows. Source producers
must write the target in the same transaction as their input and may send a
targeted wakeup only after commit; there is no targetless wakeup or automatic
provisioning. Keep `tracking-v1` disabled until all writer paths, source
coverage, and expected backlog volume are verified.

The worker and dispatcher use the application database only in
`staging-controlled-v1`. Their SQS mapping and schedule remain disabled until
explicitly enabled. Deploy the compatible worker before its dispatcher, and
deploy compatible receivers before changed senders (including `xTdhLoop`
before `tdhLoop` and `delegationsLoop`).

Controlled staging API reads additionally require a nonempty profile allowlist
(`membership_reader_profile_ids`, at most 20 IDs) and the audited coverage
revision (`membership_reader_coverage_revision`). The API starts in
`legacy`/`off`; redeployment without these inputs resets the controls. The
reader checks the exact revision on source evidence before trusting a
materialized result.
