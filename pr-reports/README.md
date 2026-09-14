# Pull Request Reports

Files in this directory are immutable historical validation records. Commands
inside an existing report show what was run at that time and must not be
rewritten as though a different command produced the evidence.

For current work, use the repo-local `6529` command documented in
[`docs/package-commands.md`](../docs/package-commands.md). In particular, use
`6529 ci`, `6529 run <script>`, and `6529 exec <binary>` instead of direct npm,
npx, or Corepack npm project commands.
