# Mint Announcements Loop

This loop posts automated mint-status messages to configured wave(s).

## Scheduler (Europe/Athens)

Configured in `serverless.yaml` with `method: scheduler` and `timezone: Europe/Athens`.

Runs:

- Mon/Wed/Fri `17:40` (Phase 0 start)
- Mon/Wed/Fri `18:30` (Phase 1 start)
- Mon/Wed/Fri `19:00` (Phase 2 start)
- Mon/Wed/Fri `19:20` (Public Phase start)
- Tue/Thu/Sat `16:00` (Public Phase ends in 1 hour reminder)
- Tue/Thu/Sat `17:00` (Mint end announcement)

DST behavior:

- Winter (UTC+2): these are `15:40, 16:30, 17:00, 17:20, 14:00, 15:00` UTC
- Summer (UTC+3): these are `14:40, 15:30, 16:00, 16:20, 13:00, 14:00` UTC

The code uses a 5-minute acceptance window for each trigger, so if the Lambda starts shortly after the cron minute, it still posts.

## Window Priority

When the loop runs, checks are evaluated in this order:

1. Phase window (`PHASE`)
2. Public phase ending soon (`PUBLIC_PHASE_ENDING_SOON`)
3. Mint end (`MINT_END`)

If none match, nothing is posted.

## One-Time Markers (Per Meme Token)

Done markers are stored by token id:

- `mint_announcements_done_meme_tokens` (phase flow completed via sold-out branch)
- `public_phase_ending_soon_announcements_done_meme_tokens` (1-hour reminder sent)
- `mint_end_announcements_done_meme_tokens` (mint-end sent)

## Sample Outputs

Assume meme `#467` named `Liberate Art`, card URL `https://6529.io/the-memes/467`.

### 1) Phase Start Run (not sold out)

Example at Phase 0 start:

```text
Meme #467 - Liberate Art

https://6529.io/the-memes/467

Phase 0 is Live!
Edition Size: 328
Remaining: 174

Minting for this phase closes at 16:20 UTC
```

Phase 1/2/Public use the same format with their phase name and close time.

### 2) Phase Start Run (sold out detected)

If `remaining <= 0` during a phase run:

```text
Meme #467 - Liberate Art

https://6529.io/the-memes/467

Mint Complete!

Edition fully minted 🚀🚀🚀

GG @[artist_handle] and all the minters :sgt_pinched_fingers:
```

After this posts, a phase done marker is written and subsequent phase windows for that token are skipped.

### 3) Public Phase Ends in 1 Hour (Tue/Thu/Sat 16:00 Athens)

If not sold out:

```text
Meme #467 - Liberate Art

https://6529.io/the-memes/467

Public Phase ends in 1 hour!
Edition Size: 328
Remaining: 174

Minting closes at 15:00 UTC
```

If sold out at this run, reminder is skipped and no message is posted.

### 4) Mint End (Tue/Thu/Sat 17:00 Athens)

```text
Meme #467 - Liberate Art

https://6529.io/the-memes/467

Minting Completed
Closing Edition Size: 328
```

After this posts, mint-end done marker is written and later mint-end runs for the same token are skipped.

## Typical Sequence

### Case A: Not sold out early

1. Mon/Wed/Fri phase starts post live messages.
2. Tue/Thu/Sat 16:00 reminder posts "ends in 1 hour" (once).
3. Tue/Thu/Sat 17:00 mint-end posts closing edition size (once).

### Case B: Sold out during phase run

1. First phase run that sees sold-out posts `Mint Complete!`.
2. Later phase runs skip.
3. 1-hour reminder skips because sold out.
4. Mint-end still posts once (closing edition size).
