import { performance } from 'node:perf_hooks';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import type { ClientRequest } from 'node:http';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import type { Logger } from '@/logging';
import { createMembershipQueueSender } from './membership-runtime-sqs';
import { validateMembershipRuntimeDeployment } from './membership-runtime-policy';

const runtime = validateMembershipRuntimeDeployment({
  stage: 'staging',
  region: 'eu-west-1',
  mode: 'staging-fixture-v1',
  queue_arn:
    'arn:aws:sqs:eu-west-1:987989283142:membership-refresh-work-staging-v1',
  queue_url:
    'https://sqs.eu-west-1.amazonaws.com/987989283142/membership-refresh-work-staging-v1'
});
const credentials = () => ({
  accessKeyId: 'fixture-access',
  secretAccessKey: 'fixture-secret',
  sessionToken: 'fixture-session'
});
const correlation = {
  request_id: 'fixture-request',
  event_id: 'fixture-event'
};
const hint = {
  target: { scope: 'PROFILE' as const, target_id: 'membership-drill-long-v1' },
  delivery: {
    requested_version: '9007199254740993',
    reserved_until_millis: '1789490000000'
  }
};
const log = { info: jest.fn() };
let now = 100;
const performanceDescriptor = Object.getOwnPropertyDescriptor(
  performance,
  'now'
);

beforeEach(() => {
  now = 100;
  log.info.mockClear();
  Object.defineProperty(performance, 'now', {
    configurable: true,
    value: () => now
  });
});
afterEach(() => {
  jest.restoreAllMocks();
  if (performanceDescriptor)
    Object.defineProperty(performance, 'now', performanceDescriptor);
  else Reflect.deleteProperty(performance, 'now');
});
const create = (identity = credentials(), mode = runtime.mode) =>
  createMembershipQueueSender(
    { ...runtime, mode },
    identity,
    correlation,
    log as unknown as Logger
  );
const budget = (signal = new AbortController().signal, deadline = 1100) => ({
  signal,
  deadline_monotonic_millis: deadline
});

describe('dedicated membership SQS sender', () => {
  it('copies credentials and fixes queue, region, one attempt and enforced finite HTTP timeouts', async () => {
    const send = jest
      .spyOn(SQSClient.prototype, 'send')
      .mockResolvedValue({ MessageId: 'fixture-message' } as never);
    const identity = credentials();
    const sender = create(identity);
    identity.accessKeyId = 'mutated-access';
    identity.secretAccessKey = 'mutated-secret';
    identity.sessionToken = 'mutated-session';
    const signal = new AbortController().signal;
    try {
      await sender.send(hint, budget(signal));
      const client = send.mock.contexts[0] as SQSClient;
      expect(await client.config.region()).toBe('eu-west-1');
      expect(await client.config.maxAttempts()).toBe(1);
      expect(await client.config.credentials()).toMatchObject(credentials());
      expect(client.config.requestHandler).toBeInstanceOf(NodeHttpHandler);
      expect(
        await Reflect.get(client.config.requestHandler, 'configProvider')
      ).toMatchObject({
        connectionTimeout: 500,
        socketTimeout: 1000,
        requestTimeout: 1500,
        throwOnRequestTimeout: true
      });
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][0]).toBeInstanceOf(SendMessageCommand);
      const command = send.mock.calls[0][0] as SendMessageCommand;
      expect(command.input).toEqual({
        QueueUrl: runtime.queue_url,
        MessageBody: JSON.stringify({ protocol_version: 1, ...hint }),
        MessageAttributes: {
          MembershipDispatcherRequestId: {
            DataType: 'String',
            StringValue: correlation.request_id
          },
          MembershipDispatcherEventId: {
            DataType: 'String',
            StringValue: correlation.event_id
          }
        }
      });
      expect(send.mock.calls[0][1]).toEqual({ abortSignal: signal });
      expect(JSON.parse(log.info.mock.calls[0][0])).toMatchObject({
        event: 'membership_dispatch_send',
        message_id: 'fixture-message',
        acknowledged_after_deadline: false
      });
    } finally {
      sender.close();
    }
  });
  it.each(['accessKeyId', 'secretAccessKey', 'sessionToken'] as const)(
    'rejects absent %s without constructing a usable sender',
    (key) => {
      expect(() => create({ ...credentials(), [key]: '' })).toThrow(
        'deployment credentials'
      );
    }
  );
  it('refuses inactive sender creation', () => {
    expect(() => create(credentials(), 'inactive')).toThrow(
      'deployment credentials'
    );
  });
  it.each([100, 99, NaN, Infinity])(
    'rejects exhausted/nonfinite deadline %s before SDK send',
    async (deadline) => {
      const send = jest.spyOn(SQSClient.prototype, 'send');
      const sender = create();
      try {
        await expect(
          sender.send(hint, budget(undefined, deadline))
        ).rejects.toThrow('deadline');
        expect(send).not.toHaveBeenCalled();
      } finally {
        sender.close();
      }
    }
  );
  it('refuses pre-aborted sends and forwards a live cancellation signal unchanged', async () => {
    const send = jest.spyOn(SQSClient.prototype, 'send').mockImplementation(
      (_command, options) =>
        new Promise((_resolve, reject) => {
          const signal = (options as { abortSignal: AbortSignal }).abortSignal;
          signal.addEventListener(
            'abort',
            () => reject(new Error('socket aborted')),
            { once: true }
          );
        }) as never
    );
    const sender = create();
    const controller = new AbortController();
    const pending = sender.send(hint, budget(controller.signal));
    const outcome = expect(pending).rejects.toThrow('socket aborted');
    controller.abort();
    await outcome;
    try {
      await expect(
        sender.send(hint, budget(controller.signal))
      ).rejects.toThrow('deadline');
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      sender.close();
    }
  });
  it('rejects late acknowledgement after the monotonic deadline without retrying an ambiguous send', async () => {
    const send = jest
      .spyOn(SQSClient.prototype, 'send')
      .mockImplementation(async () => {
        now = 1100;
        return { MessageId: 'late-message' };
      });
    const sender = create();
    try {
      await expect(sender.send(hint, budget())).rejects.toThrow(
        'after deadline'
      );
      expect(send).toHaveBeenCalledTimes(1);
      expect(JSON.parse(log.info.mock.calls[0][0])).toMatchObject({
        acknowledged_after_deadline: true,
        message_id: 'late-message'
      });
    } finally {
      sender.close();
    }
  });
  it('requires a message acknowledgement and rejects arbitrary target IDs before sending', async () => {
    const send = jest
      .spyOn(SQSClient.prototype, 'send')
      .mockResolvedValue({} as never);
    const sender = create();
    try {
      await expect(sender.send(hint, budget())).rejects.toThrow(
        'no message identity'
      );
      await expect(
        sender.send(
          { ...hint, target: { scope: 'PROFILE', target_id: 'real-profile' } },
          budget()
        )
      ).rejects.toThrow('fixture hint');
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      sender.close();
    }
  });
  it('destroys the dedicated client on close', () => {
    const destroy = jest.spyOn(SQSClient.prototype, 'destroy');
    const sender = create();
    sender.close();
    expect(destroy).toHaveBeenCalledTimes(1);
  });
  it('uses the actual SDK and NodeHttpHandler to destroy an in-flight request on abort', async () => {
    let startRequest!: () => void;
    const started = new Promise<void>((resolve) => {
      startRequest = resolve;
    });
    const request = Object.assign(new EventEmitter(), {
      end: jest.fn(),
      setTimeout: jest.fn(),
      destroy: jest.fn((): EventEmitter => {
        request.emit('close');
        return request;
      })
    });
    // Replace only the physical HTTPS boundary: no sockets or AWS requests are opened.
    const physical = jest.spyOn(https, 'request').mockImplementation((() => {
      startRequest();
      return request as unknown as ClientRequest;
    }) as typeof https.request);
    const sender = create();
    const controller = new AbortController();
    const pending = sender.send(hint, budget(controller.signal));
    const outcome = expect(pending).rejects.toMatchObject({
      name: 'AbortError'
    });
    try {
      await started;
      controller.abort();
      await outcome;
      expect(physical).toHaveBeenCalledTimes(1);
      expect(physical.mock.calls[0][0]).toMatchObject({
        host: 'sqs.eu-west-1.amazonaws.com',
        method: 'POST'
      });
      expect(request.destroy).toHaveBeenCalledTimes(1);
      expect(log.info).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      sender.close();
    }
  });
});
