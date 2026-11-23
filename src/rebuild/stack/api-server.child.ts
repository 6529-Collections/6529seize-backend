// A child of the rebuild run: serves the API on 127.0.0.1 at the run's port.
// The run bundles this file with esbuild, as the API's deploy does, and
// starts the bundle with plain Node: the guard comes first, inside it. The
// app listens on its own fixed port as soon as it is imported, so every
// listen in this process is moved to the run's loopback port first.
import '@/rebuild/guard/source-guard.preload';
import * as net from 'node:net';
import { exitWithError } from '@/rebuild/stack/child-exit';

const port = Number(process.env.REBUILD_API_PORT);
if (!Number.isInteger(port) || port <= 0) {
  throw new Error('REBUILD_API_PORT must be set');
}

type ListenOnPort = (
  this: net.Server,
  port: number,
  host: string,
  callback?: () => void
) => net.Server;

const listen = net.Server.prototype.listen as ListenOnPort;
net.Server.prototype.listen = function loopbackListen(
  this: net.Server,
  ...args: unknown[]
) {
  const callback = args.find((arg) => typeof arg === 'function') as
    | (() => void)
    | undefined;
  return listen.call(this, port, '127.0.0.1', callback);
} as typeof net.Server.prototype.listen;

const { ensureInitialized } = require('@/api/app');

(ensureInitialized as () => Promise<void>)().catch((error: unknown) => {
  exitWithError('[REBUILD API FAILED]', error);
});
