# DCO sign-off missing for PR #1315 commits

## Context
PR #1315 is blocked by the DCO check because two commits on the branch are missing `Signed-off-by` lines.

## Impact
The PR cannot be merged until the commits are rewritten with proper DCO sign-offs.

## Proposed fix
Rebase the branch with sign-off (e.g. `git rebase HEAD~2 --signoff`) and force-push, or cherry-pick into a new branch with `-s`.

## Owner
TBD
