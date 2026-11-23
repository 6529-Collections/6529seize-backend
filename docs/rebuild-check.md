# The rebuild check

The rebuild check proves that MySQL holds only an index. On a local stack it
drops every table that is not ephemeral or a provider cache, runs the
rebuilders, and compares the API's answers before and after. A rebuilder may
read only:

- the 6529 chain, through the gateway;
- the relays;
- Ethereum logs and state;
- content-addressed files, including files in this repository.

The code is in `src/rebuild/`.

## The registry

Each manifest in `src/rebuild/manifests/` covers one area of the code, its
area: identity, waves, TDH, holdings, subscriptions, minting and so on. Every
table and view that code names belongs to exactly one manifest. `src/rebuild/registry.test.ts` runs in the normal
test shards and fails when:

- an entity, a table constant, a retired table or a facade view is in no
  manifest, or in two;
- a manifest names a table code doesn't know (mark tables made at runtime with
  `origin: 'runtime'`);
- a table other than INDEX has no `why`;
- a rebuilder writes a table that isn't one of its area's INDEX tables, two
  rebuilders write one table, or steps wait on each other;
- a probe repeats an id, has a path without a leading `/`, or a placeholder
  with no values.
- a relay check names a module or export wrong or a test fixture, covers
  an empty prefix or one another area's prefix overlaps; a relay reader's
  wallet, principal, role or member wave is written wrong, a member has no
  principal, or a reader has no reason; or an open wave is a family or its
  stream.

So a new entity needs one line in its area's manifest.

## Table classes

| Class     | In the run                                     |
| --------- | ---------------------------------------------- |
| INDEX     | Dropped, then rebuilt                          |
| EPHEMERAL | Kept: sessions, queues, cursors, locks         |
| PROVIDER  | Kept: a third-party provider's data            |
| SCHEMA    | Made by the schema build; holds no data        |
| VIEW      | Made by the schema build                       |
| RETIRED   | Named in code, with no table in a fresh schema |
| EXEMPT    | Kept and reported as not covered               |

## Registering an area's parts

Edit only your area's manifest.

```ts
export const mintManifest: AreaManifest = {
  area: 'mint',
  flags: { FEATURE_EXAMPLE: 'true' },
  tables: {
    team: { class: 'INDEX' }
  },
  seeds: [],
  rebuilders: [
    {
      id: 'mint.team',
      run: { module: 'src/teamLoop/team-rebuild', exportName: 'rebuildTeam' },
      writes: ['team'],
      sources: ['repo'],
      timeoutMinutes: 5
    }
  ],
  probes: [
    {
      id: 'mint.team-airdrop',
      path: '/api/example/{card}',
      each: { card: ['1', '2'] }
    }
  ]
};
```

- `flags`: the feature flags and settings your code needs for its new path.
  The run sets them for seeds, rebuilders and the API. A flag may not set
  the run's own variables (`REBUILD_*`, `DB_*`, `ETHEREUM_RPC_URL`,
  `ALCHEMY_*`, `AWS_*` and the like); the registry refuses it.
- A table's `volatileColumns` (each with its `reason`) are left out when
  its rows are compared after the rebuild. A volatile primary-key column,
  such as an auto-increment id the API never shows, also stops keying the
  rows: they match by their other columns.
- `seeds`: steps that put the stack in its "before" state: legacy rows, kept
  rows, and the live loops run forward.
- `rebuilders`: steps that fill your INDEX tables from empty. A module step
  exports `async (ctx: RebuildContext) => void`; the run calls it inside
  `doInDbContext`, so the usual DB services work. `ctx.sources` holds the base
  URLs of the run's sources and `ctx.mark` the chain height and Ethereum block
  to rebuild to. A command step gets the same values in `REBUILD_*`
  environment variables.
  - Each rebuilder connects as its own MySQL user. It can write its `writes`
    and read its `reads`, and lock rows it reads (`SELECT ... FOR UPDATE`,
    as production writers do); anything else is refused.
  - A preload refuses every socket except MySQL and the run's sources.
  - Any id the API shows must come from the source, never from
    auto-increment or a random UUID, or the answers change.
  - A step with `origin: 'planned'` names a module a branch adds later.
    Until it is in the tree, runs skip the step and note it, and keep a
    skipped rebuilder's tables like pending ones; a final run fails.
- `probes`: API requests whose answers must match before and after. `ignore`
  and `unordered` paths each need a reason, which the registry checks. A
  probe with `origin: 'planned'` and `needs: [tables]` reads tables a later
  branch creates: runs hold it while any of them is missing from the fresh
  schema and say so, and a final run fails on it.
- `waivers`: `routes` (documented GET routes no probe needs to call),
  `unprobedTables` (rebuilt tables no probe needs to read) and
  `unseededTables` (rebuilt tables that may have no rows after the seeds),
  each entry with its reason.

## Running it

```text
6529 run rebuild:check -- --home <dir> [--area <area>] [--mark head|switch] [--final]
  [--source <name>=<spec> ...]
  [--chain-height <n>] [--eth-block <n>] [--mysql-port 3407] [--api-port <n>] [--mysqld <path>]
```

It needs a MySQL 8.0 server binary: on Windows the installed
`MySQL Server 8.0`, elsewhere `mysqld` on `PATH`, or `--mysqld`. The run
takes `<dir>/run.lock`, so two runs never share a home, starts a private
`mysqld` on 127.0.0.1 with its data under `<dir>/mysql`, and stops that
process at the end. A server a crashed run left behind is stopped only when
its data directory is this run's. The API listens on a free loopback port
unless `--api-port` names one.

The steps of a run:

1. Check the registry, start `mysqld`, build the schema from code (entity
   sync, then the migrations loop's schema steps; the old db-migrate
   scripts are left out, as in the tests), and check the live schema
   against the classes.
2. Run every area's seeds, then count the rows of every INDEX table, so the
   report shows which tables the probes can find data in.
3. Copy the kept tables aside: EPHEMERAL, PROVIDER, EXEMPT, and, unless
   `--final`, INDEX tables no rebuilder writes yet.
4. Probe the API (pass A).
5. Snapshot the rebuilt tables row by row.
6. Drop: the full run drops the database, builds the schema again and
   restores the kept tables; an `--area` run empties that area's rebuilt
   tables and restores the kept ones.
7. Run the rebuilders in `after` order, each as its own MySQL user and under
   the source guard.
8. Probe again (pass B), snapshot again, and compare.

With `--mark switch`, pass A runs without the areas' flags: the old path's
answers against the rebuilt ones.

A run passes when the registry is clean, every step exits 0 in its time, no
step connects outside the sources, no source reports a problem (a request a
recording lacks, a file that doesn't match its hash), the rebuilt tables were
empty after the drop, and every probe answers the same in both passes. A
probe whose first pass gets no answer, a 5xx, or not the `expectStatus` it
names fails every run, and so does one whose two answers differ.

A probe whose answers match but whose first answer is a 4xx, or a 2xx that
is empty, not JSON, or carries no data (an empty list, a page whose lists
are all empty, or an object whose values are all zero, false, empty or the
values the request asked about), proves nothing: the report lists it as
unproven. The no-data test can't tell a value the code fills in for a
missing row (a default such as `eligibility: 1`) from data, so the report
also counts each INDEX table's rows after the seeds: a table with none
proves nothing whatever its probes answered.

`--final` also fails on:

- unproven and held probes;
- INDEX tables without a rebuilder, and planned steps or tables whose code
  isn't in the tree;
- rebuilt tables that differ row by row outside their volatile columns;
- rebuilt tables with no rows after the seeds (unless waived), and rebuilt
  tables no probe read (unless waived);
- tables a manifest keeps or rebuilds that the schema build doesn't make;
- provisional sources, and command steps that don't run Node (the source
  guard watches only Node processes);
- documented GET routes with no probe and no waiver.

Without `--final` each of these is a note in the report.

Every process it starts gets a fresh environment: no `.env.*` file (the run
refuses to start if `.env.local` exists), no AWS or provider credentials, and
no AWS config files. Reports go to `<dir>/runs/<time>-<scope>/` (`report.md`,
`report.json`, the probe answers and every step's log), and one line per run
to `<dir>/STATUS.md`.

## Sources

Each `--source <name>=<spec>`:

| Source   | Specs                                                                        |
| -------- | ---------------------------------------------------------------------------- |
| gateway  | a devnet URL; `replay:<dir>`; `record:<dir>@<url>`                           |
| relays   | a devnet URL; `relay[:<dir>]`; `replay:<dir>[+<dir>]`; `record:<dir>@<url>`  |
| ethereum | a URL; `anvil` or `anvil:<state file>`; `replay:<dir>`; `record:<dir>@<url>` |
| files    | a directory of content-addressed files; a URL                                |

- `replay` serves `<dir>/recording.jsonl`. A request it doesn't have
  answers 599 and fails the run. `record` proxies to the URL and adds every
  new answer to the recording. Keys leave out JSON-RPC ids and key order.
- `<dir>/PROVENANCE.json` says what made a recording (`made_by`: a
  devnet scenario, an anvil state, or `hand`). Provisional, so `--final`
  fails on them: a live URL, a `record` run (it reaches a live URL), a
  recording written by hand, and the harness relay. Recording into a
  directory marked `hand` keeps that mark.
- The report shows source URLs without credentials, query values or
  key-like path segments.
- `relay` or `relay:<dir>` is the harness relay. It speaks CRP v1 over
  WebSocket (HELLO, AUTH, PUB, payloads, SUB, HIST) and keeps what the run
  publishes, starting from a copy of `<dir>`. It checks one copy per event
  id, a LOG `seq` once per wave and payloads before the records that name
  them. It checks no signatures. As on the relays, each wave has its own
  log, and a family of streams (`dv/0x..`) shares its family's (`dv`);
  rseq counts per log from 1. `SUB` replays each wave (`*`: every log)
  after its `since` cursor of this epoch, or from the start with
  `from_start`, ends each with `EOSE` at that wave's head, then sends new
  events live. `HIST` pages a log or one stream of a family; without
  `after` it answers the newest page. A CHALLENGE lives five minutes.
- It reads as the relays do (crates/wave-relay with the wave-inbox
  extension), from what the areas declare in `relayAccess`:
  - a wave of drops is read by anyone when an area lists it in
    `openWaves`; any other is members-only, read by the `site-reader` or
    by a principal its `readers` entry makes a member (`memberOf`);
  - the `ps` family is public; the other families need an AUTHed session
    whose grant hasn't expired or been revoked: `pv` streams by their
    owner's principal, or by a wallet while the owner's newest `reader`
    record for it (refs `["reader", <wallet>]`; a body of `{}` or
    `{"until": <ms>}` grants, none revokes) grants it and hasn't run out;
    the rest by the `orderer` or `site-reader`, and `bk` streams also by
    their owner;
  - a wallet has the roles, principal and memberships its `readers` entry
    gives it, and none otherwise; payloads need an AUTHed session;
  - a named wave a session may not read ends at once (`EOSE` rseq 0),
    under `*` it is passed over, and `HIST` of it answers `ERR`.
- Relays can be recorded and replayed too:
  - `record:<dir>@<relay url>` proxies the run's CRP sessions to a relay;
    `record:<dir>@relay` records a fresh harness relay on loopback. When
    the run ends, `<dir>` holds what the run saw: `events.jsonl` (each
    event with the relay's order, the other fields the relay sent with it,
    and `recorded_at`, the time the run first saw it), `payloads/`,
    `relay.json` (the head), `reads.json` (the waves the run read), and a
    fresh `PROVENANCE.json` naming how it was made. No file names the
    relay's address.
  - `replay:<dir>` serves the recording read-only, by the same read rules;
    `replay:<a>+<b>` merges several (an area's each) for the run. A PUB
    that isn't a recorded event under its recorded grant (compared as
    canonical JSON), a payload or a read of a wave the recording doesn't
    hold, a recorded event that fails a check, and a payload that doesn't
    hash to its name all fail the run. AUTH is not compared. EV frames and
    HIST items carry the recorded `recorded_at`, so area code can use the
    time its events were first seen.
  - Every recorded event goes through two checks, in a child under the
    source guard: the signed-event check the relays run on any event (the
    kind and its version, the body against its hash and size, the id
    recomputed from the fields, and the Ed25519 signature by the event's
    device key), then its area's check. A replayed recording counts for
    `--final` only when it has events and every one passes both.
    `PROVENANCE.json`'s `made_by` and `devnet_scenario` are labels the
    report shows; they never make a recording final.
  - `6529 run rebuild:relay-capture` records a whole relay without a run:
    every log it serves from its start (SUB `*`, then HIST to each log's
    end) and every payload its events name. It takes `--relay <url>`,
    `--dir <dir>`, `--net <name>`, `--made-by <text>` and, for a devnet's
    recording, `--devnet-scenario <name>`. Its `reads.json` holds `*`, so
    any run's reads replay. It needs Node and this repository, not MySQL: a
    devnet's operator runs it next to the relay.
  - An area declares its checks in its manifest's `relayChecks`: the wave
    prefixes each covers and a module export
    `(item: RelayItem, flags) => RelayCheckResult` that runs what the
    backend checks beyond the signed event (the grant, whose key may sign),
    with the area's `flags`. The check runs with no database and no
    endpoint, so it can't ask the chain or the API whose key may sign: it
    proves the key's binding to the author offline, from the grant the
    event came with. The registry refuses a module or export written
    wrong, a test fixture, an empty prefix, and a prefix two areas share;
    the registry test fails on a module not in the tree, unless planned. Seeds
    that publish to the relays must publish the same event and grant every
    run (fixed keys, clocks and randomness), so a replay accepts their PUBs
    as the recorded ones.
- `anvil` starts a local anvil (chain id 1) behind a shim that answers
  `alchemy_getAssetTransfers` from its logs and blocks. Children get the
  shim as `ETHEREUM_RPC_URL` and `ALCHEMY_BASE_URL`. The Alchemy NFT API and
  its other `alchemy_*` methods are not served; a call to them fails the run.
- The files server answers `/ipfs/<id>`, `/ar/<id>`, `/docs/<id>` and
  `/<id>` from the directory, and checks every file against
  `<dir>/files.json` (id to SHA-256). It doesn't derive an id from the
  content: an Arweave id is a transaction's, not a hash of the file, so
  `files.json` is what ties each id to its bytes. A seed can add files: it
  writes them into `ctx.seedFilesDir` and lists them in that directory's own
  `files.json`; the server checks each one's hash when it is asked for.
- A flag value may name a source: `{gateway}`, `{relays}`, `{ethereum}`
  or `{files}` become its URL in the run.

## The report

`report.md` opens with the verdict and the counts, then: failures,
registry problems, a table per area (tables, INDEX, INDEX tables with rows
after the seeds, kept, rebuilt, pending, probes, differences, unproven
probes, failed steps), each source with where its answers came from, each
step with its time and the rows in its tables afterwards, source violations,
probe differences, unproven probes, tables that differ row by row and the
columns that comparison leaves out, rebuilders that read kept tables, INDEX
tables no probe read, documented GET routes no probe calls and no waiver
names, planned tables whose code isn't in the tree, tables a fresh schema
does not have, and pending tables. `report.json` holds the same, and both
probe passes' answers sit beside it. A run that stopped before the second
pass says so, with the step that stopped it, instead of counting
differences and unproven probes it never compared.

## The harness's own check

```text
6529 exec jest --config scripts/rebuild-jest.config.cjs
```

It runs single-area runs whose rebuilders restore the seeded rows, change them, read
an undeclared table, and call a host outside the sources, and checks the
verdict of each. Its home is `.rebuild/self-check` unless
`REBUILD_SELF_CHECK_HOME` names another; `REBUILD_SELF_CHECK_PORT` sets the
`mysqld` port (default 3407). Each run takes a minute or two.
