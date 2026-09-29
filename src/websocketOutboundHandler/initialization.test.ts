import { buildSync } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

it('enqueues recipient frames after initializing the real worker import graph', () => {
  // Bundle the production entrypoint first: mocking ws/repository imports masks cycles.
  const bundle = buildSync({
    stdin: {
      resolveDir: __dirname,
      contents: `
        import './index';
        import { appWebSockets } from '@/api/ws/ws';
        import { wsConnectionRepository } from '@/api/ws/ws-connection.repository';
        import { sqs } from '@/sqs';
        import assert from 'node:assert/strict';
        process.env.NODE_ENV = 'staging';
        let accepted = 0;
        wsConnectionRepository.getByConnectionId = async () => ({
          identity_id: 'identity', jwt_expiry: Math.floor(Date.now() / 1000) + 600
        });
        sqs.sendToQueueName = async ({ message }) => {
          assert.equal(message.connectionId, 'connection');
          assert.equal(message.id, 'outbox:123');
          accepted++;
        };
        appWebSockets.send({ connectionId: 'connection', message: '{}', outboxId: 'outbox:123' })
          .then(() => { assert.equal(accepted, 1); process.exit(0); })
          .catch(error => { console.error(error); process.exit(1); });
      `
    },
    tsconfig: resolve(__dirname, '../../tsconfig.json'),
    bundle: true,
    platform: 'node',
    target: 'es2020',
    write: false
  }).outputFiles[0]!.text;
  // No handler invocation, DB or AWS access: only the session lookup and SQS boundary are stubbed.
  expect(() =>
    execFileSync(process.execPath, ['-'], {
      input: `process.argv[1] = 'websocket-worker-smoke.js';\n${bundle}`,
      timeout: 20000,
      stdio: 'pipe',
      maxBuffer: 1024 * 1024
    })
  ).not.toThrow();
});
