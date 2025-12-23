# Commiting to Git
**NEVER commit unless explicitly asked to by the user.** Do not assume the user wants you to commit. Wait for explicit instructions like "commit" or "commit this".

When you DO commit (only when explicitly asked), add a DCO signature to footer with my name and the corresponding accountcode+username@users.noreply.github.com email address. Example:
```
Add tests for address comparison
Signed-off-by: IAmAUser <1234567+IAmAUser@users.noreply.github.com>
```

# Writing unit tests
1. Put the tests next to file being tested.
2. Test file name should always end with `.test.ts`
3. Words in test file names should always be separated with dashes (except for the suffix `.test.ts`) and be all lowercase. For example if you test function doThis then the test file should be `do-this.test.ts`
4. Use fast-check where reasonable
5. When doing DB/Repository tests take example from file src/profiles/abusiveness-check.db.test.ts

# Linting
After you do your changes then run `npm run lint`. Make sure you fix all errors and warnings.