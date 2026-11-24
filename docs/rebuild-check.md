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
  rebuilders write one table (unless each writes a disjoint partition of
  it), or steps wait on each other;
- a column owner owns a column another owner owns, a partition or
  checkpoint column, or columns of a table no rebuilder writes the rows of,
  or doesn't run after that row writer; a step both writes a table's rows
  and owns columns of it; a write names both columns and a partition;
- a step plans rows while it is a seed, of a table whose rows it doesn't
  write, or without a `where`, a reason or an `until`;
- a step reads a table no manifest has, or needs an unknown table, a
  VIEW, RETIRED or SCHEMA table, or one without a reason; a rebuilder is
  marked `last`, or a seed that isn't last waits on one that is;
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

A cursor its rebuilder rewrites is INDEX, not EPHEMERAL: kept, it would
make the rebuilder resume from it and write nothing. The identity mirror's
`identity_chain_mirror_state` is one.

An EXEMPT table can name the last day of its exemption, `until:
'YYYY-MM-DD'`. The report lists it with its day and reason. Once the run's
day (UTC) is past it, the run notes "EXEMPT overdue: <table> since <day>"
on the headline and the status line; it doesn't fail, so a run doesn't
turn red because the clock moved. A final run fails on every EXEMPT table
that names an `until`, whatever the day. The registry refuses an `until`
on any other class, and one that isn't a real day.

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
- An INDEX table's `exemptColumns` (each with its `reason`) are columns no
  step rebuilds: named clock or random columns a step can't reproduce, each
  until a dated follow-up derives it from block times. The comparison
  leaves them out like volatile ones, and the report lists each with its
  reason. A column can't be both exempt and owned by a column
  owner, and a run fails at its start when the schema lacks one.
- An INDEX table whose readers take only its one newest row, such as a
  checkpoint each indexing run writes, can set
  `checkpoint: { column, reason }`. The comparison then takes only the
  rows holding the column's largest value, as MySQL compares it
  (`MAX`), which must match in every non-volatile column, and leaves
  older rows out, since a seed that indexed twice has more of them than a
  rebuild that indexed once. It is one newest row for the whole table: a
  table whose readers take the newest row per key must not use it. The
  registry refuses it on other classes and without a column or a reason,
  and a run fails when the column may hold NULL.
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
  - Rebuilders of different areas can share an INDEX table by partition:
    each lists it in `writes` as
    `{ table, partition: { columns, values, reason } }`, its rows being
    those whose `columns` hold one of the tuples in `values` (for example
    columns `['family', 'type']`, values `[['pv', 'follow']]`). The
    registry allows several writers on one table only when every one
    declares a partition on the same columns and no two share a tuple (an
    early warning, folding case and accents as the default collation does,
    with trailing spaces significant); a writer of the whole table excludes
    all others. Before the seeds, the run compares every pair of tuples
    from different writers in MySQL, under each column's own collation,
    and fails on any pair MySQL takes as one value. After the seeds, rows
    in no writer's partition are noted, and a final run fails on them. A
    rebuilder that changes any row outside its partition fails the run.
    The rows are compared as one table; an area run empties and rebuilds
    only the area's own partitions.
  - A rebuilder can own columns of a table another rebuilder (its row
    writer) writes the rows of, for example columns other loops keep up to
    date on rows one area writes: it lists `{ table, columns, reason }` in
    `writes` and runs after the row writer (`after`). MySQL holds both to
    it with column grants: the row writer may insert every column (its live
    insert may carry values into the owned ones), update every other
    column, and delete rows; the owner may only update its columns. A step
    that writes outside them fails, and the run names the step, the column
    and the table. Once the table's last running row writer is done, the
    run resets the running owners' columns on every row, to the default,
    NULL, or a NOT NULL column's zero (0, or an empty string), so the owners
    fill them again whatever the row writer, a kept copy or another area
    left there. The run digests the owner's table without its columns (the
    row set and every other column, leaving out what MySQL writes itself:
    ON UPDATE and generated columns) before and after it runs, and fails on
    any change. At its start the run fails on an owned column the schema
    lacks, one in the primary key, a generated one (MySQL writes it), one
    it can't reset (NOT NULL, with no default, of a type with no zero), and
    on a table with owners but no primary key or with a volatile or exempt
    column in it (a key that changes on a rebuild matches no saved row). A
    writer of the table that reads it doesn't wait on its owners; owners
    run in their `after` order, so one that reads another's columns names
    it there. When a table's row writer doesn't run (it is another
    area's, or skipped), the table keeps its rows. When an owner doesn't
    run, the run saves its columns with each row's key before the
    drop and puts them back after the last running row writer, so the
    API's answers keep them; they are still left out of the comparison and
    listed with why (another area's, planned, or waiting for a table), as
    planned tables are, and a final run fails on them.
  - A rebuilder can list
    `plannedRows: [{ table, where, reason, until, change }]`: rows of a
    table it writes that only a later change rebuilds, such as rows
    another step creates once their ids change. `where` is an SQL
    condition on the table's columns, which may use a `NOT EXISTS` against
    other tables, evaluated on the seeded rows; `until` is the plan's last
    day, `YYYY-MM-DD`, and `change` names the later change that brings
    the rows' source. A seeded row it matches that the rebuild lacks is
    listed as planned with its key and doesn't make the table differ. A
    row the rebuild adds or changes still differs, matching or not, and
    rows without a primary key are counted per identical row, so a plan
    excuses only as many as it matched. The report lists every plan with
    the seeded rows it matched and how many the rebuild lacks, and notes
    a plan that matched no seeded rows and one whose rows the rebuild
    writes now (drop the plan). Past its day a plan is noted as overdue on
    the headline and the status line ("planned rows overdue: <table> since
    <day>"). A final run fails on every plan of a running rebuilder,
    whatever it matched. A plan covers only rows its own rebuilder writes:
    a run that finds a planned row in another running writer's partition
    fails.
    A plan with `columns: [...]` plans only those columns of the rows it
    matches: the rows must come back, and may differ only in those
    columns; every other column of them, and every other row, is
    compared as usual, and a matched row that is missing still differs.
    Where two column plans match one row, their columns add up. The
    report lists each such plan with its columns, the rows it matched,
    how many came back changed in any of its columns (per column), how
    many of those were left out of the differences, and the keys of the
    rows left out; a plan none of whose rows is missing or changed in its
    columns is noted as one to drop. A run refuses, at its start, a
    planned column the schema doesn't have or that sits in the primary
    key, and a column plan on a table without a primary key free of
    volatile columns, as the rows are found by key. A row that both a
    plan of whole rows and a column plan match is refused too: one says
    it may be missing, the other that it must come back. The registry
    refuses a column name that isn't plain, a name twice, and a column
    another rebuilder owns, compared without regard to case.
    Plans don't excuse probe answers: a probe over planned rows would
    answer differently while they are missing, so it stays a planned
    probe, held by its `needs`, until the rows' source exists.
  - A step with `origin: 'planned'` names a module a branch adds later.
    Until it is in the tree, runs skip the step and note it, and keep a
    skipped rebuilder's tables like pending ones; a final run fails.
    While its module isn't here, the order checks leave its writes out: a
    reader of a table it writes, and an owner of columns of it, needn't
    wait on it yet, and the report notes each such step with its tables.
    Its own reads are still checked: it must wait on the writers of the
    tables it reads. Whether its module is here is decided once, when the
    run starts, for each step: a seed and a rebuilder may not share an
    id. A module path must be a path in the repo without an extension,
    spelled as the tree spells it, with no part ending in a dot or a space
    or holding a colon; a module reached through a link or a junction is
    not here.
    Once the module is here, they are checked like any other step's. An
    unknown id in its `after` or `before` still fails. A final run also
    fails on a step still marked planned whose code is here: nothing
    planned passes a final check.
  - A step (seed or rebuilder) with `needs: [{ table, reason }]` runs only
    when every table it needs is in the run's schema. While one is missing
    (a table another branch creates), runs skip it the same way, and the
    report names the step, the table and the reason; a final run fails.
    A step waits for a table a later branch adds. The registry refuses a
    view, a retired or a schema table, and a needed table without a reason.
    A need on a table the schema already has (its branch landed first)
    holds nothing back: the step runs, the run notes the need as one to
    drop, and a final run fails on it.
    A step that waits on a skipped one and touches the same tables should
    declare the same needs.
  - A seed with `last: true` runs after every seed without it, in the
    usual order among the last ones. A chain indexer uses it to catch up
    on blocks other seeds mined after it first ran, so the tables it seeds
    reach the chain's head before the first pass. The registry refuses
    `last` on a rebuilder, and an `after` from a seed that isn't last onto
    one that is.
  - `before: [step ids]` is the mirror of `after`: the named steps wait for
    this one, so an area can order its step ahead of another area's
    without editing that area's manifest. The registry refuses an unknown
    id (a planned step counts as known), a cycle across `before` and
    `after`, and a last seed's `before` onto a seed that isn't last; a
    seed may run before a last one. An id whose prefix (up to its first
    dot) is another known area than the step's own, for a step this tree
    doesn't have yet, is an unresolved cross-area edge rather than an
    unknown id: the run notes it, the headline and the status line count
    it, and a final run fails on it. By convention the step that writes
    the table declares the edge; nothing enforces it. Once the other
    area's step is in the tree, the edge is checked like any other. An unknown id of the step's own area,
    with a prefix that names no area, or with an empty part, still fails,
    and so does an id of the other kind of step (a rebuilder naming a seed,
    or a seed a rebuilder): order holds within one kind. When the other
    area has a step whose id is a couple of letters off, the note asks
    "did you mean <id>?".
- `probes`: API requests whose answers must match before and after. `ignore`
  and `unordered` paths each need a reason, which the registry checks. Mark
  `unordered` any list the backend selects without `ORDER BY`, such as
  follows' `actions` and the `subscribed_actions` of drops and identities:
  MySQL may return it in another order in the second pass. A probe with
  `origin: 'planned'` and `needs: [tables]` reads tables a later branch
  creates: runs hold it while any of them is missing from the fresh schema
  and say so, and a final run fails on it.
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
  isn't in the tree; steps marked planned whose code is;
- plans of planned rows, and EXEMPT tables that name an `until`;
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
  devnet scenario, an anvil state, or `hand`), as a label for the report.
  Provisional, so `--final` fails on them: a live URL, a `record` run (it
  reaches a live URL), the harness relay, every gateway or ethereum
  recording, and a files directory that holds any file. Nothing verifies
  a recording's answers yet, and a label is never a basis, so the report
  says "answers not verified" whatever `PROVENANCE.json` says; checking
  the node's proofs (for ethereum, the blocks' hash chain and receipt
  proofs) is what will let one count. `anvil` from a state file records
  nothing and counts.
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
  The seeds' files are the run's own world. Files in `<dir>` come from
  outside the run, and nothing checks their ids against their bytes yet,
  so a directory that holds any is provisional ("ids not verified"),
  whatever its `PROVENANCE.json` says.
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
