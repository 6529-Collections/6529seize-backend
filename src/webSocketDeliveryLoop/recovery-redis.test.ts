import { once } from 'node:events';
import { AddressInfo, createServer } from 'node:net';
import { WebSocketDeliveryStore } from '@/ws-delivery/ws-delivery-store';
import { connectWebSocketRecoveryRedis } from './recovery-redis';

type Command = { name: string; bytes: number };

// Read one RESP command. The fixture only inspects command names.
function readCommand(input: Buffer): Command | undefined {
  const endOfCount = input.indexOf('\r\n');
  if (endOfCount < 0) return;
  const count = Number(input.toString('ascii', 1, endOfCount));
  let cursor = endOfCount + 2;
  let name = '';
  for (let i = 0; i < count; i++) {
    const endOfSize = input.indexOf('\r\n', cursor);
    if (endOfSize < 0) return;
    const size = Number(input.toString('ascii', cursor + 1, endOfSize));
    const start = endOfSize + 2;
    cursor = start + size + 2;
    if (cursor > input.length) return;
    if (i === 0) name = input.toString('ascii', start, start + size);
  }
  return { name, bytes: cursor };
}

it('follows a Redis MOVED to the same endpoint and loads a missing script by key', async () => {
  const commands: string[] = [];
  let discoveries = 0;
  const server = createServer((socket) => {
    let input = Buffer.alloc(0);
    socket.on('data', (data) => {
      input = Buffer.concat([input, data]);
      let command: Command | undefined;
      while ((command = readCommand(input))) {
        input = input.subarray(command.bytes);
        commands.push(command.name);
        switch (command.name) {
          case 'CLUSTER':
            discoveries++;
            socket.write(
              `*1\r\n*3\r\n:0\r\n:16383\r\n*3\r\n$9\r\n127.0.0.1\r\n:${port}\r\n$4\r\nnode\r\n`
            );
            break;
          case 'ZRANGEBYSCORE':
            if (discoveries === 1) {
              socket.end(`-MOVED 10238 127.0.0.1:${port}\r\n`);
            } else {
              socket.write('*0\r\n');
            }
            break;
          case 'EVALSHA':
            socket.write('-NOSCRIPT No matching script\r\n');
            break;
          case 'EVAL':
            socket.write('*1\r\n*5\r\n:1\r\n:0\r\n:0\r\n:0\r\n:0\r\n');
            break;
          case 'CLIENT':
            socket.write('+OK\r\n');
            break;
          default:
            socket.write('-ERR Unexpected test command\r\n');
        }
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  const originalEnv = process.env;
  process.env = {
    ...originalEnv,
    REDIS_URL: '127.0.0.1',
    REDIS_PORT: String(port),
    REDIS_TLS: 'false'
  };
  delete process.env.REDIS_PASSWORD;
  let cluster:
    | Awaited<ReturnType<typeof connectWebSocketRecoveryRedis>>
    | undefined;
  try {
    cluster = await connectWebSocketRecoveryRedis();
    const store = new WebSocketDeliveryStore(
      () => true,
      () => cluster ?? null
    );
    await expect(store.due(Date.now())).resolves.toEqual([]);
    expect(commands.filter((name) => name !== 'CLIENT')).toEqual([
      'CLUSTER',
      'ZRANGEBYSCORE',
      'CLUSTER',
      'ZRANGEBYSCORE'
    ]);
    await expect(
      store.claim('connection', 'token', true, Date.now())
    ).resolves.toMatchObject({ acquired: true });
    expect(commands.slice(-2)).toEqual(['EVALSHA', 'EVAL']);
  } finally {
    process.env = originalEnv;
    await cluster?.disconnect();
    server.close();
    await once(server, 'close');
  }
});
