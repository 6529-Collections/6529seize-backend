import { metricEnvironment } from './metric-environment';

describe('metricEnvironment', () => {
  it.each([
    ['prod', 'prod'],
    ['production', 'prod'],
    ['api_prod', 'prod'],
    ['staging', 'staging'],
    ['api_staging', 'staging'],
    ['development', 'dev'],
    ['local', 'dev'],
    ['test', 'dev'],
    ['', 'unknown'],
    ['preview', 'unknown'],
    ['reproduction', 'unknown']
  ])('maps %p to %p', (configured, expected) => {
    expect(metricEnvironment(configured)).toBe(expected);
  });
});
