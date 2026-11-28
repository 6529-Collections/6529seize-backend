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
  marked `last`, or a seed that isn't last waits on or needs one that is;
- a step needs an unknown step, itself, or one without a reason, or a
  seed needs a rebuilder;
- a probe repeats an id, has a path without a leading `/`, or a placeholder
  with no values.

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

`chain_pending_operations` and `chain_pending_operation_signers` are
EPHEMERAL: identity joins waiting for a second signature expire within a
day, and after a rebuild the holder starts the join again.

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
- An INDEX table whose primary key holds such a number can declare
  `rowKey: [...]`, columns that are exactly one of its UNIQUE indexes,
  all NOT NULL, such as `waves.id` where `serial_no` is the primary key.
  The comparison then keys its rows by them, so a row whose number moved
  is the same row, changed in that column, not one row gone and another
  added. Planned rows, column plans and owned columns find their rows by
  the row key too. The registry refuses a rowKey on other classes,
  without columns, with a column named twice, or holding a volatile or
  exempt column; a run fails at its start when a column isn't spelt as
  the schema spells it (rows come back under the schema's names), when no
  UNIQUE index has exactly those columns, or when one may hold NULL (a
  UNIQUE index lets rows share a NULL), and notes a rowKey that is the
  primary key. The report
  lists the tables keyed by a declared row key.
- A volatile column can name `where`, an SQL condition on the table's
  columns as a plan's: it is then left out only of the rows the
  condition matches, such as `serial_no` on the chain-made waves
  (`id LIKE '0x%'`), so the imported waves' serials are still compared.
  The run reads the condition on each side, with the main database as
  default, taking a row as matched where a WHERE would; a row it matches
  on one side only keeps the column on the other, so it shows as changed
  even when the value is the same. The table needs a row key without the
  column or any column left out of every row (its rowKey, or a primary
  key without them), since the rows are found by key, and the condition
  can't name the column itself (a name in a string counts too); a run
  fails at its start on either, on a column not spelt as the schema
  spells it, and on a condition MySQL can't read. The report lists
  each scoped column with its condition, the rows it matched of each
  side's, and those matched on one side only. A final run treats a
  scoped volatile column as any volatile one.
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
  URLs of the run's sources, `ctx.mark` the chain height and Ethereum block
  to rebuild to, `ctx.final` whether the run is a final one (`--final`), and
  `ctx.seedFilesDir`, for a seed in a run that serves files, the directory
  its own files go in (see the files server below). A command step gets the
  sources and the mark in `REBUILD_*` environment variables, and the whole
  context, `final` included, only as JSON in `REBUILD_CONTEXT`.
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
    lacks, one in the primary key or the declared row key, a generated one
    (MySQL writes it), one it can't reset (NOT NULL, with no default, of a
    type with no zero), and on a table with owners but no row key (its
    declared rowKey, else its primary key) or with a volatile or exempt
    column in it (a key that changes on a rebuild matches no saved row). A
    writer of the table that reads it doesn't wait on its owners; owners
    run in their `after` order, so one that reads another's columns names
    it there. When a table's row writer doesn't run (it is another
    area's, or skipped), the table keeps its rows. When an owner doesn't
    run, the run saves its columns with each row's key before the
    drop and puts them back after the last running row writer, so the
    API's answers keep them; they are still left out of the comparison and
    listed with why (another area's, planned, waiting for a table, or
    needing a step that doesn't run), as planned tables are, and a final
    run fails on them.
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
    planned column the schema doesn't have or that sits in the row key
    (the declared rowKey, else the primary key), and a column plan on a
    table without a row key free of volatile columns, as the rows are
    found by key. A row that both a
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
  - A step with `needsSteps: [{ step, reason }]` needs those steps to have
    run before it in the same run. It waits on each, as with `after`, and
    runs only when each runs: while one is skipped as planned (its code
    isn't here, a table it needs is missing, or a step it needs doesn't
    run), runs skip it the same way, keep its tables like a skipped
    step's, and the report names the step, the step it needs and the
    reason; a final run fails. Every seed runs in every run, so a seed's
    needs depend only on whether the seeds it needs run. An area run
    starts only its areas' rebuilders and empties only their tables, so a
    rebuilder that needs another area's rebuilder is skipped there
    ("outside this area run"): run in it, that rebuilder would write onto
    that area's rows, which were seeded and never emptied. So a column
    owner orders itself after its table's row writer with `after`, not
    `needsSteps`: a need on another area's row writer would skip the owner
    in its own area's runs. Unlike `after`, a need may cross kinds one
    way: a rebuilder may need a seed, which every run has run by then. A
    need names a step some manifest declares: an id no manifest has fails
    as unknown, even with another area's prefix, where an `after` on it
    is an unresolved cross-area edge. The registry refuses an unknown
    step, a step that needs itself, a seed that needs a rebuilder (every
    seed runs before the rebuilders) and a need without a reason.
  - A seed with `last: true` runs after every seed without it, in the
    usual order among the last ones. A chain indexer uses it to catch up
    on blocks other seeds mined after it first ran, so the tables it seeds
    reach the chain's head before the first pass. The registry refuses
    `last` on a rebuilder, and an `after` or a need from a seed that isn't
    last onto one that is.
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
2. Run every area's seeds in `after` and `before` order, those marked
   `last` after all the others, then count the rows of every INDEX table, so
   the report shows which tables the probes can find data in. Here and in
   step 7, a step whose needed table isn't in the schema is skipped as
   planned. Identity's seeds come first: identity.probe-profiles gives the
   world's actors (src/rebuild/manifests/probe-fixture.ts), and
   identity.actors-check fails the run unless every actor the world holds
   has the world's fixed profile id under each of its wallets and the
   chain's principal of it, and the two probes, whose ids seeds take
   without reading, are held. An actor the world lacks is noted in the
   step's log. A unit test (`src/rebuild/world-actors-guard.test.ts`) pins
   every file under `src` that holds a raw write into `profiles` (SQL, a
   write helper handed the table, or a row set tagged with it), and how
   many: the profiles and identity mirror write paths,
   identity.probe-profiles (its plain rows of the world's actors when the
   run has no identity world), the identity rebuilder's restore of the
   untaken placeholders' profiles, and the test fixtures' profiles row set
   and its one caller. The records service is one of the world's actors:
   the mint and publish seeds read it by its wallet and write no profile.
   Any other raw write fails the test until it is reviewed and listed;
   writes through the ORM are outside it.
3. Copy the kept tables aside: EPHEMERAL, PROVIDER, EXEMPT, and, unless
   `--final`, INDEX tables no rebuilder writes yet.
4. Probe the API (pass A).
5. Snapshot the rebuilt tables row by row.
6. Drop: the full run drops the database, builds the schema again and
   restores the kept tables; an `--area` run empties that area's rebuilt
   tables and restores the kept ones.
7. Run the rebuilders in `after` and `before` order, each as its own MySQL
   user and under the source guard.
8. Probe again (pass B), snapshot again, and compare.

With `--mark switch`, pass A runs without the areas' flags: the old path's
answers against the rebuilt ones.

A run passes when the registry is clean, every step exits 0 in its time, no
step connects outside the sources, no source reports a problem (a request a
recording lacks or its server failed on, a call the Alchemy stand-in failed
on, a file that doesn't match its hash), the rebuilt tables were
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
- documented GET routes with no probe and no waiver;
- steps skipped while a table they need isn't in the schema, and needs on
  a table the schema already has;
- rows of a shared table in no writer's partition.

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
| relays   | a devnet URL; `relay` or `relay:<dir>`: the harness relay                    |
| ethereum | a URL; `anvil` or `anvil:<state file>`; `replay:<dir>`; `record:<dir>@<url>` |
| files    | a directory of content-addressed files; a URL                                |

- `replay` serves `<dir>/recording.jsonl`. A request it doesn't have
  answers 599 and fails the run. `record` proxies to the URL and adds every
  new answer to the recording. Keys leave out JSON-RPC ids and key order. A
  request the server fails on answers 502 `replay failed` and fails the run;
  the error is in the report. `record` sends each request only to a path
  under the URL, with the URL's own query first: a target that isn't a
  path (an absolute URL, `//host`) or whose dot segments climb out of the
  URL's path answers 400 and fails the run, and nothing is fetched.
- `<dir>/PROVENANCE.json` says what made a recording (`made_by`: a
  devnet scenario, an anvil state, or `hand`), as a label for the report.
  Provisional, so `--final` fails on them: a live URL, a `record` run (it
  reaches a live URL), the harness relay, every gateway or ethereum
  recording, and a files directory that holds a file whose id nothing
  checks (see the files server below). Nothing verifies a recording's
  answers yet, and a label is never a basis, so the report says "answers
  not verified" whatever `PROVENANCE.json` says; checking
  the node's proofs (for ethereum, the blocks' hash chain and receipt
  proofs) is what will let one count. `anvil` from a state file records
  nothing and counts.
- The report shows source URLs without credentials, query values or
  key-like path segments.
- The harness relay speaks CRP v1 over WebSocket (HELLO, AUTH, PUB, payloads,
  SUB, HIST). It keeps what the run publishes, starting from a copy of
  `<dir>`, and checks one copy per event id, a LOG `seq` once per wave
  and payloads before the records that name them. It checks no signatures.
- `anvil` starts a local anvil (chain id 1) behind a shim that answers
  `alchemy_getAssetTransfers` from its logs and blocks. Children get the
  shim as `ETHEREUM_RPC_URL` and `ALCHEMY_BASE_URL`. The Alchemy NFT API and
  its other `alchemy_*` methods are not served; a call to them fails the run.
  A call the shim fails on answers the JSON-RPC error `shim error` and fails
  the run; the error is in the report. `ALCHEMY_BASE_URL` is honoured only
  on a loopback host (127.0.0.1, ::1 or localhost), since the Alchemy key
  travels in its path: an `ethereum` URL on another host fails a step as
  soon as it makes its Alchemy client.
- The files server answers `/ipfs/<id>`, `/ar/<id>`, `/docs/<id>` and
  `/<id>` from the directory, and checks every file against
  `<dir>/files.json` (id to SHA-256). It derives an id from the content
  only for a SHA-256 or a Keccak-256 name (below): an Arweave id is a
  transaction's, not a hash of the file, so for other names `files.json`
  is what ties each id to its bytes. Startup reads and hashes every file
  of the directory, which it then serves from memory. A seed can add files: it writes them into
  `ctx.seedFilesDir` and lists them in that directory's own `files.json`;
  the server checks each one's hash when it is asked for.
  The seeds' files are the run's own world. Files in `<dir>` come from
  outside the run. A file named by the SHA-256 of its bytes, as lowercase
  hex or as a raw CIDv1 with a sha2-256 multihash (`bafkrei...`, the
  document store's naming), has its id checked against its bytes, and one
  with other bytes fails the run. For any other file nothing checks its id
  yet, so a directory that holds one is provisional ("ids not verified",
  naming the files), whatever its `PROVENANCE.json` says.
  A file named `keccak256-<64 lowercase hex>` has its Keccak-256 checked
  against its bytes the same way; another name that starts `keccak256-`
  in any case (capitals, an extension) fails the run. Such a file counts
  as verified only when the chain vouches for its name:
  - the Waves v1 file is the one named by the `fileHash` of the chain's
    import answer, which the run reads from the gateway's recording: an
    exchange keyed as a GET of `/v1/waves/import`, answered 200 with
    `completed: true`. If those answers name more than one file, none
    counts. It must be a Waves v1 file (schema `0x411D`, version 1). In
    record mode a fresh recording holds no such answer yet, so the import
    files wait;
  - the drop archives' index (`drop-archives`, the snapshot tool's
    `archives/index.json`) is accepted only when the root over its
    (waveId, hash) pairs, strictly ascending by waveId, equals that Waves
    v1 file's dropArchiveRoot, its own `dropArchiveRoot` (when it gives
    one) is that root, and each entry's 6529.io wave UUID derives its
    waveId; its `file` and `drops` are informative and aren't checked;
  - an archive counts once the checked index names it, at the size
    (`bytes`) the index lists.

  The root is computed here from the chain spec's definition, not by the
  code that reads the archives. All of them count only while the gateway
  source is verified: a name from a gateway answer that isn't verified
  yet vouches for nothing, and the reason says so. Until an import answer
  names a Waves v1 file that is served, the Waves v1 file, the index and
  its archives stay provisional, with the reason, and fail nothing. A
  fault in the index, a root that differs, or an archive of another size
  fails the run. Any other Keccak-named file stays provisional.
- A flag value may name a source: `{gateway}`, `{relays}`, `{ethereum}`
  or `{files}` become its URL in the run.

## The identity area

The identity area's seed and rebuilder run the identity mirror against the
gateway source (`src/identity-chain-mirror/identity-chain-mirror.rebuild.ts`),
so an identity run needs a gateway whose chain has an identity import, and
a files source holding the profile documents. The mirror reads each
document from the files source under its CID's name (`b` and its base32),
and checks the bytes against the CID: the gateway's document store is not a
chain read, so a recording of the chain does not hold it. The identity
world is a devnet's, captured in the shared gateway recording beside the
waves area's world, with a files directory of the import's documents and an
identity-world.json that gives the world's wallets, principals, network id
and mark (`rebuild-world/world-ids.ts` holds them). The keyed wallets come
from test keys fixed by a label, so they stay the same from one capture to
the next; the two principals made on the chain change. Run the identity
area alone with that recording (every gateway recording is provisional):

```text
6529 run rebuild:check -- --home <dir> --area identity
  --source gateway=replay:<the shared recording>
  --source files=<its files directory>
```

Without a gateway whose chain has an identity import the seed writes the
world's actors (the probes and the identities other areas' seeds read by
wallet) as plain rows, so other areas' runs with their own sources keep
working, and the identity rebuilder fails.

The mirror lists 6529.io's placeholder profiles (handle `id-<wallet>`)
from `profiles` at its first run; after a drop there are none. The
rebuilder reads them from the "placeholders at freeze" file instead
(`src/identity-chain-mirror/placeholder-restore.ts`): every placeholder
profile as stored at the identity freeze, with its identities row and
wallets, as gzipped NDJSON, pinned by its SHA-256 in the code and served by
the files source under that name. From the freeze nothing makes or changes a
placeholder, and until switch-on nothing takes one, so the file holds the
set the mirror's first run lists. The rebuilder:

1. lists every placeholder of the file in `identity_chain_placeholders`, as
   the mirror's first run does, so the founder rule gives an identity made
   on the chain the same profile id;
2. runs the mirror to the mark, then on until the walk that gives the rows
   off the chain a level of REP + TDH has reached the end of the
   identities, as the delegations loop's runs do over time;
3. restores each placeholder no chain identity took (no mapping): its
   `profiles` row, and its `identities` and `address_consolidation_keys`
   rows without the wallets the mirror's rows hold, as the mirror's
   re-keying leaves another identity's row (none left, no row). Its TDH
   columns start at 0: only the TDH loop writes TDH onto identities rows,
   and no rebuilder does yet. It refuses a placeholder whose profile id a
   `profiles` row already holds, which would be a second profile under that
   id.

It checks the whole file before it writes anything, and refuses it on any
line that isn't a placeholder, a profile, wallet or identity wallet given
twice, or a count that differs.

Each mirror run walks 20,000 `identities` rows (20 chunks of 1,000 keys).
While the mirror runs, the table holds the switch-on record's rows and the
rows the mirror writes for chain identities; the placeholders' rows come
back only afterwards, with `level_raw` = REP, the walk's rule with TDH at 0.
So the walk needs ceil(N / 20,000) runs for N rows, one more when it starts
mid-table: 6 for 100,000 rows, 16 for 300,000, 57 for 1.1 million. N is
known only once the team's record and the chain's identities exist. These
walk runs come after the five runs that catch up with the chain, are held
to ceil(N / 20,000) + 1 with N counted once, each must move the walk's
cursor, and none starts after 10 minutes; each one's time is logged. A walk
run's time is an estimate (a few seconds), not measured: at 1.1 million rows
the 57 runs fit the 10 minutes only at under about 10.5 seconds a run, and
the first run on real data logs the figure.

1,019,000 made-up placeholders took 28 seconds to list and 10 minutes to
restore on one connection. With the mirror's runs (47 minutes at most: 35
to catch up, 12 for the walk) the rebuilder's timeout is 75 minutes.

As the writer of `identities`, `profiles`, `address_consolidation_keys`
and `identity_chain_principals`, the rebuilder names the rebuilders that
read them in its `before`: `holdings.ethereum`, `personal.settings`,
`subs.legacy-history`, `subs.top-ups`, `waves.chain-mirror` and
`tdh.chain-days`. An edge to a step not yet in the tree is noted, not
refused.

Until the freeze writes the real file and its SHA-256 is pinned
(`FREEZE_PLACEHOLDERS_SHA256`), the steps read the world's fixture, which
the world's code builds from its ids (`rebuild-world/fixture-file.ts`), so
the repository holds no address. The seed writes it into the run's seed
files, the run's own world, so any files source serves it. The identity
steps refuse it on a final run, which needs the real file in the files
directory (`ctx.final`; the seed `identity.probe-profiles` first, which
then writes no fixture).

The seed writes 6529.io rows the chain doesn't hold, each on an identity
only its site probe reads (`rebuild-world/site-rows.ts`): the file's
placeholder profiles through the site's own code (one the founder rule
takes, and two none takes, one of them with TDH), a TDH-only identity
(which step B of the TDH loop makes before switch-on, with a random
profile id), an address-only identity on the founder's wallet (as a user
group made with it writes one; the world fixes its id), and TDH on an
imported identity. It writes
`tdh_consolidation`, the TDH area's table, for its own wallets; once the
TDH area's seed writes the shared scenario's TDH rows, it provides those
too. The run shows what a rebuild from the chain and the file does to each.

The switch-on record (`switch-on-record.ts`) carries the rows no rebuild
can derive: every identity with no handle and no chain identity, and its
address keys, as 6529.io holds them right before the identity mirror's
first run (the 6529.io team takes it then, just before it sets the
mirror's flag; the format is `tdh-only-record.ts`). Their ids were issued
at random before switch-on, and the mirror adopts such a row's id for a
chain identity on the same consolidation key. So the rebuilder loads the
record's rows first, before the mirror replays, and the mirror adopts the
same ids again. The seed takes the world's record at the same moment, after
6529.io's writes before switch-on, and writes its two files (named by their
SHA-256) and a pins file into the run's seed files. The founder's chain
identity adopts the address-only row on its wallet, so the run shows an
adopted id rebuilt as the live one. A final run reads the team's record by
its pins (`SWITCH_ON_RECORD_PINS`) and refuses the world's.

The record carries a row's `tdh` as taken, not `basetdh_rate` or the xTDH
columns, so a loaded row starts with `basetdh_rate` 0, as step B and the
address-only writes leave it. TDH's columns are the TDH area's: its
`tdh.chain-days` rebuilder, after the mirror, writes `tdh` and
`basetdh_rate` on every identities row, the record's included, and the xTDH
columns read 0 from switch-on. Two things for the change that pins the
team's take: a run on real data shows the record's rows' `basetdh_rate` only
once `tdh.chain-days` writes it; and runs on the rebuild world keep the
world's take (its TDH-only row and the founder's adoption), not the team's,
as the placeholders file needs once `FREEZE_PLACEHOLDERS_SHA256` is pinned.

No rebuilder writes TDH onto identities rows (`tdh`, `basetdh_rate`) yet,
and the team's record isn't pinned yet, so the rebuilder declares both as
plans (in its manifest), until 2026-11-30:

- the `identities` and `address_consolidation_keys` rows the record
  carries, planned rows (`TDH_ONLY_PLANNED_ROWS`), ended when the team's
  record is pinned and a run on it rebuilds them with nothing differing.
  The plans select what the record takes, every identity with no handle
  and no chain identity, TDH or not (address-only ones too), less the ids
  the mirrors derive from an address after switch-on, which they rebuild.
  On the world, whose record the rebuild loads, the report notes the plans'
  rows as rebuilt;
- `tdh` and `basetdh_rate` on the imported identity and the untaken
  placeholder, a column plan (`TDH_COLUMN_PLANS`), ended when the TDH area
  writes identities' tdh from the chain (its tdh.chain-days rebuilder).

The probes `identity.site.tdh` and `identity.site.untaken-placeholder-tdh`
leave `$.tdh` out for the same reason. Plans don't excuse probe answers, so
the TDH-only identity has no probe until its rows are seeded. The report
lists each plan with the rows it matched. A full run can show more, from
the planted references below.

With the waves world in the recording, the seed also gives four of its
people 6529.io TDH (`WAVES_PEOPLE_TDH` in `rebuild-world/world-ids.ts`), so
their votes and wave ratings have credit, which from switch-on is
`identities.tdh` alone: a consolidated TDH row on each one's consolidation
key, with that key's wallets, then the scoped metrics sync, as for the site
rows. A recording without them (an identity-only world) skips this; one
holding only some is refused. From switch-on 6529.io's TDH mirrors the
chain's day by day, so the seed models 6529.io at the mark: each value is
the person's TDH on the chain at the mark's TDH day, 20782 in the shared
gateway capture (…01c2 26,709, …01c3 23,967, …01c4 33,566, and …01c7 28,416
after its second wallet left). No site TDH above it is seeded. The rebuild
leaves their `tdh` and `basetdh_rate` at 0, so the four pairs are one
column plan on `identities` (`TDH_COLUMN_PLANS`), until 2026-11-30,
ended when the TDH area writes identities' tdh from the chain at the
mark's day. TDH moves daily: a capture whose mark falls on another TDH
day needs these values moved with it.

A second seed, `identity.placeholder-references`, plants one row of each
kind of reference to a profile (follows, mutes, notifications, reactions,
settings, moderation, proxies and the rest, except encrypted DMs, which the
DM area rebuilds only from its relay records;
`rebuild-world/placeholder-references.ts`), each naming the untaken
placeholder and, where a kind needs another profile, a probe identity by
the world's fixed id, which `identity.actors-check` proves the world holds
before this seed runs; the `identity.site.placeholder-*` probes read the
ones the API shows to others. Each kind is provisional until
6529.io's own counts of such references come. Most of those tables are
other areas': a run keeps them as seeded until their areas rebuild them,
and then a reference their rebuild doesn't bring back shows as a
difference there.

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
verdict of each. It also runs a step that waits on a planned table no code
creates (in a normal run and a final one), a step whose need the schema
already meets, and partitioned writers of one table: an area run that
rebuilds only its own partition, and, in an area run and a full run of
every area, a writer whose partition of a kept table is emptied before it
runs. The column owners' runs give a row writer and the owner of one of
its table's columns: the row writer inserts and deletes rows under column
grants, owned columns are reset before the owner runs and on rows kept
for a skipped writer, and a row writer that updates an owned column, or
an owner that adds a row or writes another column, fails. An exempt
column is left out of the comparison with its reason; an owner that
doesn't run here, another area's or a planned one, has its column left
out and noted, and a planned one fails a final run; a table a step
writes but its writes don't name is named. Three runs go through the
API: two compare its answers before and after the rebuild, and one reads
an owned column whose owner is absent. Its home is `.rebuild/self-check`
unless `REBUILD_SELF_CHECK_HOME` names another; `REBUILD_SELF_CHECK_PORT`
sets the `mysqld` port (default 3407). Each run takes a minute or two.
