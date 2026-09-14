import { spawnSync } from 'node:child_process';

export function runAws(executable, args, capture = false) {
  const result = spawnSync(executable, args, {
    shell: false,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit'
  });
  const operation = args.slice(0, 2).join(' ');
  if (result.error) {
    const code = /^[A-Z0-9_]+$/.test(result.error.code ?? '')
      ? result.error.code
      : 'SPAWN_FAILED';
    throw new Error(`AWS ${operation} could not start (${code})`);
  }
  if (result.status !== 0) {
    // Only read-only AWS metadata calls are captured; never echo command arguments.
    const diagnostic = capture
      ? (result.stderr ?? '').trim().slice(0, 4096)
      : '';
    throw new Error(
      `AWS ${operation} failed${diagnostic ? `: ${diagnostic}` : ''}`
    );
  }
  return capture ? result.stdout.trim() : '';
}
