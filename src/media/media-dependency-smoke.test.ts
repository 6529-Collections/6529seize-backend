import type { Callback, Context } from 'aws-lambda';
import { withMediaDependencySmoke } from '@/media/media-dependency-smoke';

const context = {} as Context;
const callback: Callback = () => undefined;

it('executes bounded native operations without invoking business processing', async () => {
  const business = jest.fn();
  const result = await withMediaDependencySmoke(business)(
    { operator_action: 'verify_media_dependencies_v1' },
    context,
    callback
  );
  expect(result).toMatchObject({
    status: 'ok',
    sharp: '0.35.4',
    vips: '8.18.6',
    heif: '1.23.2'
  });
  expect(business).not.toHaveBeenCalled();
});

it.each([
  { Records: [] },
  {},
  {
    queryStringParameters: { operator_action: 'verify_media_dependencies_v1' }
  },
  {
    version: '1.0',
    httpMethod: 'POST',
    path: '/mediaResizerLoop',
    requestContext: { requestId: 'synthetic-http-proxy' },
    body: '{"operator_action":"verify_media_dependencies_v1"}',
    isBase64Encoded: false
  },
  { operator_action: 'verify_media_dependencies_v1', Records: [] }
])(
  'passes normal events and HTTP parameters through unchanged',
  async (event) => {
    const business = jest.fn().mockResolvedValue('business-result');
    expect(
      await withMediaDependencySmoke(business)(event, context, callback)
    ).toBe('business-result');
    expect(business).toHaveBeenCalledWith(event, context, callback);
  }
);

it('preserves SQS partial-batch responses without changing their contents', async () => {
  const response = { batchItemFailures: [{ itemIdentifier: 'retry-fixture' }] };
  const business = jest.fn().mockResolvedValue(response);
  expect(
    await withMediaDependencySmoke(business)({ Records: [] }, context, callback)
  ).toBe(response);
});
