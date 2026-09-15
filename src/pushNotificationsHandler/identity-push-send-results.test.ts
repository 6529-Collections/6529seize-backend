import * as admin from 'firebase-admin';
import * as database from '@/db';
import { Logger } from '@/logging';
import { withOperationalContext } from '@/operational-errors';
import { transports } from 'winston';
import { PushNotificationDevice } from '@/entities/IPushNotification';
import { handleSendResults } from './identityPushNotifications';
import {
  PushNotificationMessageInput,
  sendMessages
} from './sendPushNotifications';

jest.mock('firebase-admin', () => ({ apps: [{}], messaging: jest.fn() }));

const privateText = 'PRIVATE_PROVIDER_TOKEN_BODY_URL_STACK_CREDENTIAL';
const providerError = (code: string) =>
  Object.assign(new Error(privateText), { code });
function input(
  id: number,
  device = 1,
  imageUrl?: string
): PushNotificationMessageInput {
  return {
    notification_id: id,
    title: 'Test',
    body: 'Test',
    token: `token-${device}`,
    extra_data: {},
    imageUrl
  };
}
function messages(inputs: PushNotificationMessageInput[]) {
  return inputs.map((value, index) => ({
    input: value,
    identityId: 'profile',
    device: {
      profile_id: 'profile',
      device_id: `device-${index}`,
      token: value.token
    }
  }));
}

describe('push send outcomes across reporting layers', () => {
  const originalEnvironment = process.env;
  const sendEach = jest.fn();
  const send = jest.fn();
  const deleteDevice = jest.fn();
  const repository = jest.fn();
  let output: jest.SpyInstance;
  let localOutput: string[];

  beforeEach(() => {
    process.env = {
      ...originalEnvironment,
      AWS_LAMBDA_FUNCTION_NAME: 'pushNotificationsHandler',
      OPS_ENVIRONMENT: 'staging'
    };
    sendEach.mockReset();
    send.mockReset();
    deleteDevice.mockReset();
    repository.mockReset();
    deleteDevice.mockResolvedValue({ affected: 1 });
    repository.mockReturnValue({ delete: deleteDevice });
    jest
      .spyOn(database, 'getDataSource')
      .mockReturnValue({ getRepository: repository } as never);
    (admin.messaging as jest.Mock).mockReturnValue({ sendEach, send });
    output = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    localOutput = [];
    jest
      .spyOn(transports.Console.prototype, 'log')
      .mockImplementation((info, callback) => {
        localOutput.push(
          String((info as Record<symbol, unknown>)[Symbol.for('message')])
        );
        if (typeof callback === 'function') callback();
      });
  });
  afterEach(() => {
    jest.restoreAllMocks();
    process.env = originalEnvironment;
    expect(localOutput.join('')).not.toContain(privateText);
  });

  function envelopes() {
    return output.mock.calls.flatMap(([value]) => {
      try {
        const row = JSON.parse(String(value));
        return row._type === '6529.ops.error.v1' ? [row] : [];
      } catch {
        return [];
      }
    });
  }

  it('acknowledges mixed success while retaining the failed device result and one alert', async () => {
    const error = providerError('messaging/mismatched-credential');
    const failed = { success: false, error };
    const success = { success: true, messageId: 'accepted-by-fcm' };
    sendEach.mockResolvedValue({
      successCount: 1,
      failureCount: 1,
      responses: [failed, success]
    });
    const inputs = [input(1, 1), input(1, 2)];
    await withOperationalContext('request-mixed', async () => {
      const results = await sendMessages(inputs);
      expect(results[0].response).toBe(failed);
      expect(results[0].response.error).toBe(error);
      expect(results[1].response).toBe(success);
      expect(results.map((r) => r.input)).toEqual(inputs);
      await expect(
        handleSendResults(messages(inputs), results)
      ).resolves.toEqual([]);
    });
    expect(envelopes()).toHaveLength(1);
    expect(envelopes()[0].correlationId).toBe('request-mixed');
    expect(deleteDevice).not.toHaveBeenCalled();
    expect(
      output.mock.calls.map(([value]) => String(value)).join('')
    ).not.toContain(privateText);
  });

  it('keeps local preparation failures separate from successful provider sends', async () => {
    const inputs = [input(1), input(2)];
    inputs[0].extra_data = { redirect: 'x'.repeat(4096) };
    sendEach.mockResolvedValue({
      successCount: 1,
      failureCount: 0,
      responses: [{ success: true, messageId: 'accepted' }]
    });
    await withOperationalContext('request-prepare', async () => {
      const results = await sendMessages(inputs);
      expect(results[0].diagnosticError?.stage).toBe('prepare');
      expect(results[0].response.error?.code).toBe(
        'messaging/payload-size-limit-exceeded'
      );
      expect(results[1].response.success).toBe(true);
      await expect(
        handleSendResults(messages(inputs), results)
      ).resolves.toEqual([1]);
    });
    expect(sendEach.mock.calls[0][0]).toHaveLength(1);
    expect(envelopes()).toHaveLength(1);
    expect(localOutput.join('')).toContain(
      '[prepare/FCM_PAYLOAD_SIZE_LIMIT_EXCEEDED]'
    );
    expect(deleteDevice).not.toHaveBeenCalled();
  });

  it('retries each all-failed notification and keeps separate device rejections distinct', async () => {
    sendEach.mockResolvedValue({
      successCount: 0,
      failureCount: 3,
      responses: [
        {
          success: false,
          error: providerError('messaging/mismatched-credential')
        },
        {
          success: false,
          error: providerError('messaging/mismatched-credential')
        },
        { success: false, error: providerError('messaging/server-unavailable') }
      ]
    });
    const inputs = [input(1, 1), input(1, 2), input(2, 3)];
    await withOperationalContext('request-failed', async () => {
      const results = await sendMessages(inputs);
      await expect(
        handleSendResults(messages(inputs), results)
      ).resolves.toEqual([1, 2]);
    });
    expect(envelopes()).toHaveLength(3);
    expect(envelopes()[0].fingerprint).toBe(envelopes()[1].fingerprint);
    expect(envelopes()[1].fingerprint).not.toBe(envelopes()[2].fingerprint);
    expect(deleteDevice).not.toHaveBeenCalled();
  });

  it('counts a thrown SDK batch once but creates a fresh diagnostic for the next attempt', async () => {
    const error = providerError('messaging/server-unavailable');
    sendEach.mockRejectedValue(error);
    const inputs = [input(1), input(2)];
    await withOperationalContext('request-batches', async () => {
      const first = await sendMessages(inputs);
      expect(first[0].diagnosticError).toBe(first[1].diagnosticError);
      first.forEach((r) => expect(r.response.error).toBe(error));
      await expect(handleSendResults(messages(inputs), first)).resolves.toEqual(
        [1, 2]
      );
      expect(envelopes()).toHaveLength(1);
      const second = await sendMessages(inputs);
      expect(second[0].diagnosticError).not.toBe(first[0].diagnosticError);
      await expect(
        handleSendResults(messages(inputs), second)
      ).resolves.toEqual([1, 2]);
    });
    expect(envelopes()).toHaveLength(2);
  });

  it.each([
    'messaging/invalid-registration-token',
    'messaging/registration-token-not-registered'
  ])('keeps exact cleanup criteria for %s', async (code) => {
    const error = providerError(code);
    sendEach.mockResolvedValue({
      successCount: 0,
      failureCount: 1,
      responses: [{ success: false, error }]
    });
    const inputs = [input(7)];
    await withOperationalContext('request-cleanup', async () => {
      const results = await sendMessages(inputs);
      expect(results[0].response.error).toBe(error);
      await expect(
        handleSendResults(messages(inputs), results)
      ).resolves.toEqual([]);
    });
    expect(repository).toHaveBeenCalledWith(PushNotificationDevice);
    expect(deleteDevice).toHaveBeenCalledTimes(1);
    expect(deleteDevice).toHaveBeenCalledWith({
      profile_id: 'profile',
      device_id: 'device-0',
      token: 'token-1'
    });
    expect(envelopes()).toHaveLength(1);
  });

  it('retains the existing no-retry decision when invalid-token cleanup itself fails', async () => {
    sendEach.mockResolvedValue({
      successCount: 0,
      failureCount: 1,
      responses: [
        {
          success: false,
          error: providerError('messaging/registration-token-not-registered')
        }
      ]
    });
    deleteDevice.mockRejectedValue(new Error('synthetic database failure'));
    const inputs = [input(7)];
    await withOperationalContext('request-cleanup-failed', async () => {
      await expect(
        handleSendResults(messages(inputs), await sendMessages(inputs))
      ).resolves.toEqual([]);
    });
    expect(deleteDevice).toHaveBeenCalledTimes(1);
  });

  it('recovers without image and emits no terminal alert or provider message', async () => {
    const initial = providerError('messaging/invalid-payload');
    sendEach.mockResolvedValue({
      successCount: 0,
      failureCount: 1,
      responses: [{ success: false, error: initial }]
    });
    send.mockResolvedValue('recovered');
    const inputs = [input(1, 1, 'https://example.com/image.png')];
    await withOperationalContext('request-image', async () => {
      const results = await sendMessages(inputs);
      expect(results[0].response).toEqual({
        success: true,
        messageId: 'recovered'
      });
      expect(results[0].diagnosticError).toBeUndefined();
      await expect(
        handleSendResults(messages(inputs), results)
      ).resolves.toEqual([]);
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].notification.imageUrl).toBeUndefined();
    expect(envelopes()).toHaveLength(0);
    expect(
      output.mock.calls.map(([value]) => String(value)).join('')
    ).not.toContain(privateText);
  });

  it('reports only the final image retry failure and preserves its original error', async () => {
    sendEach.mockResolvedValue({
      successCount: 0,
      failureCount: 1,
      responses: [
        { success: false, error: providerError('messaging/invalid-payload') }
      ]
    });
    const finalError = providerError('messaging/server-unavailable');
    send.mockRejectedValue(finalError);
    const inputs = [input(1, 1, 'https://example.com/image.png')];
    await withOperationalContext('request-image-failed', async () => {
      const results = await sendMessages(inputs);
      expect(results[0].response.error).toBe(finalError);
      expect(results[0].diagnosticError?.stage).toBe('image_retry');
      await expect(
        handleSendResults(messages(inputs), results)
      ).resolves.toEqual([1]);
    });
    expect(envelopes()).toHaveLength(1);
  });

  it('keeps terminal send results when the diagnostic logger throws', async () => {
    const error = providerError('messaging/mismatched-credential');
    const response = { success: false, error };
    sendEach.mockResolvedValue({
      successCount: 0,
      failureCount: 1,
      responses: [response]
    });
    jest
      .spyOn(Logger.get('PUSH_NOTIFICATIONS_HANDLER_SEND'), 'error')
      .mockImplementation(() => {
        throw new Error(privateText);
      });
    const inputs = [input(1)];
    const results = await sendMessages(inputs);
    expect(results[0].response).toBe(response);
    await expect(handleSendResults(messages(inputs), results)).resolves.toEqual(
      [1]
    );
    expect(deleteDevice).not.toHaveBeenCalled();
  });

  it('keeps image recovery when its safe retry-info logger throws', async () => {
    sendEach.mockResolvedValue({
      successCount: 0,
      failureCount: 1,
      responses: [
        { success: false, error: providerError('messaging/invalid-payload') }
      ]
    });
    send.mockResolvedValue('recovered');
    const logger = Logger.get('PUSH_NOTIFICATIONS_HANDLER_SEND');
    const originalInfo = logger.info.bind(logger);
    jest.spyOn(logger, 'info').mockImplementation((message) => {
      if (String(message).startsWith('FCM_INVALID_PAYLOAD:'))
        throw new Error(privateText);
      originalInfo(message);
    });
    const inputs = [input(1, 1, 'https://example.com/image.png')];
    const results = await sendMessages(inputs);
    expect(results[0].response.success).toBe(true);
    await expect(handleSendResults(messages(inputs), results)).resolves.toEqual(
      []
    );
    expect(envelopes()).toHaveLength(0);
  });
});
