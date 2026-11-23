import * as fs from 'node:fs';
import * as path from 'node:path';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === 'EPERM';
  }
}

/**
 * Takes `<home>/run.lock` for this process, so two runs never share one
 * private server. A lock whose process has ended is taken over. Returns the
 * function that releases it.
 */
export function acquireHomeLock(home: string): () => void {
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, 'run.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, `${process.pid}\n`, { flag: 'wx' });
      return () => {
        if (fs.readFileSync(file, 'utf8').trim() === String(process.pid)) {
          fs.rmSync(file, { force: true });
        }
      };
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error;
      const holder = Number(fs.readFileSync(file, 'utf8').trim());
      if (Number.isInteger(holder) && holder > 0 && alive(holder)) {
        throw new Error(
          `Another rebuild run (pid ${holder}) is using ${home}; wait for it or use another --home`
        );
      }
      fs.rmSync(file, { force: true });
    }
  }
  throw new Error(`Could not take ${file}`);
}
