import { registerPushNotificationTokenRequestSchema as schema } from './register-push-notification.schema';

const legacy = { device_id: 'phone', token: 'fcm-token' };
const secret = 'a'.repeat(64);

it('keeps legacy registration valid and accepts paired installation credentials', () => {
  expect(schema.validate(legacy).error).toBeUndefined();
  expect(
    schema.validate({
      ...legacy,
      installation_secret: secret,
      installation_revision: 0
    }).error
  ).toBeUndefined();
});

it.each([{ installation_secret: secret }, { installation_revision: 0 }])(
  'rejects incomplete installation credentials: %j',
  (credential) => {
    expect(schema.validate({ ...legacy, ...credential }).error).toBeDefined();
  }
);

it('accepts the full unsigned revision range and rejects overflow', () => {
  const request = {
    ...legacy,
    installation_secret: secret,
    installation_revision: 4294967295
  };
  expect(schema.validate(request).error).toBeUndefined();
  expect(
    schema.validate({ ...request, installation_revision: 4294967296 }).error
  ).toBeDefined();
});
