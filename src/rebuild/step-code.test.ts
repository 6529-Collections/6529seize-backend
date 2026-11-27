import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RebuildStep } from '@/rebuild/manifest.types';
import { modulePathProblem, stepCodeIn } from '@/rebuild/step-code';

const planned = (module: string): RebuildStep => ({
  id: 'a.later',
  run: { module, exportName: 'run' },
  writes: [],
  sources: ['repo'],
  timeoutMinutes: 5,
  origin: 'planned'
});

describe('step code in the tree', () => {
  let root: string;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'step-code-'));
    fs.mkdirSync(path.join(root, 'src', 'later', 'folder.ts'), {
      recursive: true
    });
    fs.writeFileSync(path.join(root, 'src', 'later', 'mirror.ts'), '');
    fs.writeFileSync(path.join(root, 'src', 'later', 'built.js'), '');
    // A junction (a link on Linux) to a folder that holds a module.
    fs.mkdirSync(path.join(root, 'elsewhere'));
    fs.writeFileSync(path.join(root, 'elsewhere', 'mirror.ts'), '');
    fs.symlinkSync(
      path.join(root, 'elsewhere'),
      path.join(root, 'src', 'linked'),
      'junction'
    );
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('finds a planned module as a .ts or .js file, spelled as the tree spells it', () => {
    const here = stepCodeIn(root);
    expect(here(planned('src/later/mirror'))).toBe(true);
    expect(here(planned('src/later/built'))).toBe(true);
    expect(here(planned('src/later/missing'))).toBe(false);
    // Case as the directory lists it, on Windows as on Linux.
    expect(here(planned('src/later/Mirror'))).toBe(false);
    expect(here(planned('src/Later/mirror'))).toBe(false);
    // A directory named like the file is no module.
    expect(here(planned('src/later/folder'))).toBe(false);
    // A path that leaves the repo or names its extension is never here.
    expect(here(planned('src/later/../later/mirror'))).toBe(false);
    expect(here(planned('src/later/mirror.ts'))).toBe(false);
    // Through a link or junction: not this tree's code.
    expect(here(planned('src/linked/mirror'))).toBe(false);
  });

  it('counts a step that is not planned, or runs a command, as here', () => {
    const here = stepCodeIn(root);
    const { origin: _, ...unplanned } = planned('src/later/missing');
    expect(here(unplanned)).toBe(true);
    expect(
      here({ ...planned('src/later/missing'), run: { command: ['node'] } })
    ).toBe(true);
  });

  it('takes only a path in the repo without an extension', () => {
    expect(modulePathProblem('src/teamLoop/team-rebuild')).toBeNull();
    // A module's own dots are no extension.
    expect(modulePathProblem('src/mint-log/mint-log-rebuild.seed')).toBeNull();
    expect(modulePathProblem('../outside/x')).toBe(
      'leaves the repo or has an empty part'
    );
    expect(modulePathProblem('src//x')).toBe(
      'leaves the repo or has an empty part'
    );
    expect(modulePathProblem('/abs/x')).toBe('is absolute');
    expect(modulePathProblem('C:x')).toBe('is absolute');
    expect(modulePathProblem('src\\x')).toBe(
      'has a backslash; parts are split by /'
    );
    for (const odd of ['src/later./x', 'src/later /x', 'src/a:b/x']) {
      expect(modulePathProblem(odd)).toBe(
        'has a part ending in a dot or a space, or with a colon'
      );
    }
    expect(modulePathProblem('src/x.ts')).toBe('carries an extension');
    expect(modulePathProblem('src/x.js')).toBe('carries an extension');
  });
});
