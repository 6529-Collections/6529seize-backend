# Legacy competition migration is retired

The application migration, catch-up, shadow comparison and reverse tools are
retired. Existing live original competitions already have native ownership.
The retained migration Lambda is disabled with zero reserved concurrency and
an inert handler; it cannot enroll a wave, continue a pending copy or recreate
retired writes. Its physical infrastructure and database objects remain for the
separate infrastructure/schema chunk.

Use the [application runtime retirement runbook](./competition-runtime-retirement.md)
for the additive history transfer, parity verification, worker transition and
permanent compatibility contracts. Do not restore the old flags or migrator as
rollback. Preserve existing original-primary IDs and accepted native effects.
