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
- a step reads a table no manifest has, or needs an unknown table, a
  VIEW, RETIRED or SCHEMA table, or one without a reason; a rebuilder is
  marked `last`, or a seed that isn't last waits on one that is;
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
    and fails on any pair MySQL takes as one value. After the seeds, rows in no writer's partition are noted, and
    a final run fails on them. A rebuilder that changes any row outside
    its partition fails the run. The rows are compared as one table; an
    area run empties and rebuilds only the area's own partitions.
  - A step with `origin: 'planned'` names a module a branch adds later.
    Until it is in the tree, runs skip the step and note it, and keep a
    skipped rebuilder's tables like pending ones; a final run fails.
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
    seed may run before a last one.
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
| relays   | a devnet URL; `relay` or `relay:<dir>`: the harness relay                    |
| ethereum | a URL; `anvil` or `anvil:<state file>`; `replay:<dir>`; `record:<dir>@<url>` |
| files    | a directory of content-addressed files; a URL                                |

- `replay` serves `<dir>/recording.jsonl`. A request it doesn't have
  answers 599 and fails the run. `record` proxies to the URL and adds every
  new answer to the recording. Keys leave out JSON-RPC ids and key order.
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
- The files server answers `/ipfs/<id>`, `/ar/<id>`, `/docs/<id>` and
  `/<id>` from the directory, and checks every file against
  `<dir>/files.json` (id to SHA-256). It derives an id from the content
  only for a SHA-256 name (below): an Arweave id is a transaction's, not a
  hash of the file, so for other names `files.json` is what ties each id
  to its bytes. A seed can add files: it writes them into
  `ctx.seedFilesDir` and lists them in that directory's own `files.json`;
  the server checks each one's hash when it is asked for.
  The seeds' files are the run's own world. Files in `<dir>` come from
  outside the run. A file named by the SHA-256 of its bytes, as lowercase
  hex or as a raw CIDv1 with a sha2-256 multihash (`bafkrei...`, the
  document store's naming), has its id checked against its bytes, and one
  with other bytes fails the run. For any other file nothing checks its id
  yet, so a directory that holds one is provisional ("ids not verified",
  naming the files), whatever its `PROVENANCE.json` says.
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
