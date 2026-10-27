import { parseReplayRequest } from './replay-request';

const request = {
  mode: 'nft-history-replay',
  action: 'dry-run',
  fromBlock: 100,
  toBlock: 200,
  cutoffBlock: 300
};
const jobId = '55000000-0000-4000-8000-000000000001';

it('keeps ordinary scheduled invocations on the normal ingestion path', () => {
  expect(
    parseReplayRequest({
      source: 'aws.events',
      'detail-type': 'Scheduled Event'
    })
  ).toBeNull();
  expect(parseReplayRequest(undefined)).toBeNull();
});
it('requires an explicit bounded range and fixed cutoff', () => {
  expect(parseReplayRequest(request)).toEqual(request);
  for (const change of [
    { fromBlock: -1 },
    { fromBlock: '100' },
    { toBlock: Infinity },
    { toBlock: 99 },
    { toBlock: 2100, cutoffBlock: 2100 },
    { cutoffBlock: 150 },
    { extra: true }
  ]) {
    expect(() => parseReplayRequest({ ...request, ...change })).toThrow();
  }
});
it('requires the reviewed digest and a new UUID for apply', () => {
  expect(() => parseReplayRequest({ ...request, action: 'apply' })).toThrow();
  expect(
    parseReplayRequest({
      ...request,
      action: 'apply',
      jobId,
      approvalDigest: 'a'.repeat(64)
    })
  ).toEqual({
    ...request,
    action: 'apply',
    jobId,
    approvalDigest: 'a'.repeat(64)
  });
});
it('rejects scheduled replay and malformed replay payloads', () => {
  expect(() =>
    parseReplayRequest({ ...request, source: 'aws.events' })
  ).toThrow();
  expect(() => parseReplayRequest({ ...request, mode: 'replay' })).toThrow();
  expect(() => parseReplayRequest({ action: 'apply', jobId })).toThrow();
});
