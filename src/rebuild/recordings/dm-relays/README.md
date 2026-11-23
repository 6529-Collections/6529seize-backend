# dm relay recording

What the dm seed (`src/rebuild/steps/e2ee-relay.steps.ts`, `seedE2ee`)
published to the harness relay: 31 records in the six e2ee families
(`cv`, `dv`, `dr`, `bl`, `bk`, `md`), their payloads, and the waves the
run read. The seed's clock starts at 2026-11-23 00:00 UTC and its
randomness is seeded, so it publishes the same records every run.

Replay it with:

```
rebuild:check --area dm --source relays=replay:src/rebuild/recordings/dm-relays
```

It counts for a final run because every event passes the harness's
signed-event check and the dm relay check (`checkE2eeRelayItem`, against
the orderer's pinned key). `PROVENANCE.json` is the recorder's label of how
it was made, nothing more.

## Record it again

When the seed or the records it writes change, the replay fails with
"differs from the recording". Then:

1. Record into an empty directory:
   `rebuild:check --area dm --source relays=record:<dir>@relay`
2. Record a second time into another empty directory. Both must match
   byte for byte apart from their `recorded_at` times.
3. Replace the files here with the first one's (keep this README), and
   replay it.
