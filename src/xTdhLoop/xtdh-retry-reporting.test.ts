import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { XTdhIdentitySnapshotChangedError } from '@/xtdh/xtdh-identity-snapshot-changed-error';
import {
  enrichXTdhSentryEvent,
  getXTdhReceiveCount,
  shouldCaptureXTdhError,
  XTDH_FINAL_ATTEMPT
} from './xtdh-retry-reporting';

const sqsEvent = (count: unknown) => ({
  Records: [{ attributes: { ApproximateReceiveCount: count } }]
});

it.each([1, 2, 3, 4])('suppresses conflict attempt %s', (count) => {
  const error = new XTdhIdentitySnapshotChangedError();
  error.receiveCount = getXTdhReceiveCount(sqsEvent(String(count)));
  expect(shouldCaptureXTdhError(error)).toBe(false);
});

it.each([5, 6, 100])('reports exhausted conflict attempt %s', (count) => {
  const error = new XTdhIdentitySnapshotChangedError();
  error.receiveCount = getXTdhReceiveCount(sqsEvent(String(count)));
  expect(shouldCaptureXTdhError(error)).toBe(true);
});

it.each([
  undefined,
  null,
  1,
  '',
  '0',
  '-1',
  '1.5',
  ' 1 ',
  '1\n',
  '1e0',
  'NaN',
  'Infinity',
  '9007199254740992'
])('reports conflicts with invalid receive count %s', (count) => {
  const error = new XTdhIdentitySnapshotChangedError();
  error.receiveCount = getXTdhReceiveCount(sqsEvent(count));
  expect(error.receiveCount).toBeUndefined();
  expect(shouldCaptureXTdhError(error)).toBe(true);
});

it.each([
  undefined,
  {},
  { Records: [] },
  { Records: [null] },
  { Records: [{}] },
  { Records: [{ attributes: null }] },
  { Records: [...sqsEvent('1').Records, ...sqsEvent('2').Records] }
])('reports conflicts without unambiguous SQS metadata: %j', (event) => {
  const error = new XTdhIdentitySnapshotChangedError();
  error.receiveCount = getXTdhReceiveCount(event);
  expect(error.receiveCount).toBeUndefined();
  expect(shouldCaptureXTdhError(error)).toBe(true);
});

it('reports unrelated errors, including errors with the same message', () => {
  const conflict = new XTdhIdentitySnapshotChangedError();
  expect(shouldCaptureXTdhError(new Error(conflict.message))).toBe(true);
  expect(shouldCaptureXTdhError(new Error('database unavailable'))).toBe(true);
  expect(shouldCaptureXTdhError('unknown failure')).toBe(true);
});

it.each([undefined, 5])(
  'enriches reported conflicts at attempt %s',
  (count) => {
    const error = new XTdhIdentitySnapshotChangedError();
    error.receiveCount = count;
    expect(
      enrichXTdhSentryEvent({ extra: { existing: 'kept' } }, error)
    ).toEqual({
      extra: {
        existing: 'kept',
        xtdh_receive_count: count ?? 'unknown',
        xtdh_final_attempt: 5
      }
    });
  }
);

it('preserves unrelated Sentry events', () => {
  const event = { extra: { existing: 'kept' } };
  expect(enrichXTdhSentryEvent(event, new Error('other failure'))).toBe(event);
});

it('keeps the reporting boundary aligned with the deployed retry budget', () => {
  const config = parseDocument(
    readFileSync(join(__dirname, 'serverless.yaml'), 'utf8')
  ).toJS();
  expect(
    config.resources.Resources.XTdhStartQueue.Properties.RedrivePolicy
      .maxReceiveCount
  ).toBe(XTDH_FINAL_ATTEMPT);
});
