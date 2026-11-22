import * as fs from 'node:fs';
import * as path from 'node:path';
import { startAnvil } from '@/rebuild/sources/anvil';
import { startCrpRelay } from '@/rebuild/sources/crp-relay';
import { startFileServer } from '@/rebuild/sources/file-server';
import { startHttpRecording } from '@/rebuild/sources/http-recording';
import { RunningSource } from '@/rebuild/sources/running-source';
import {
  SourceSpec,
  SourceSpecs,
  URL_SOURCES,
  UrlSource
} from '@/rebuild/sources/source-spec';

function live(name: UrlSource, url: string): RunningSource {
  return {
    name,
    url,
    info: { url, mode: 'live', provenance: url, provisional: false },
    problems: () => [],
    stop: () => Promise.resolve()
  };
}

async function startOne(
  name: UrlSource,
  spec: SourceSpec,
  runDir: string
): Promise<RunningSource> {
  switch (spec.kind) {
    case 'live':
      return live(name, spec.url);
    case 'replay':
      if (!fs.existsSync(spec.dir)) {
        throw new Error(`${name}: no recording at ${spec.dir}`);
      }
      return startHttpRecording({ name, dir: spec.dir });
    case 'record':
      return startHttpRecording({
        name,
        dir: spec.dir,
        upstream: spec.upstream
      });
    case 'files':
      return startFileServer(spec.dir);
    case 'anvil':
      return startAnvil({
        state: spec.state,
        logFile: path.join(runDir, 'logs', 'anvil.log')
      });
    case 'relay': {
      // A copy per run, so a run's publishes never reach the recorded events.
      const dir = path.join(runDir, 'sources', 'relays');
      fs.mkdirSync(dir, { recursive: true });
      if (spec.dir) fs.cpSync(spec.dir, dir, { recursive: true });
      return startCrpRelay(dir);
    }
  }
}

/** Starts every configured source; on a failure stops the ones started. */
export async function startSources(
  specs: SourceSpecs,
  runDir: string
): Promise<RunningSource[]> {
  const running: RunningSource[] = [];
  try {
    for (const name of URL_SOURCES) {
      const spec = specs[name];
      if (spec) running.push(await startOne(name, spec, runDir));
    }
  } catch (error) {
    await stopSources(running);
    throw error;
  }
  return running;
}

export async function stopSources(
  running: readonly RunningSource[]
): Promise<void> {
  for (const source of running) await source.stop().catch(() => undefined);
}
