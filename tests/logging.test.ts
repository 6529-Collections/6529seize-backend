import * as mcache from 'memory-cache';
import { jest } from '@jest/globals';

// Mock winston to capture log calls
jest.mock('winston', () => {
  const info = jest.fn();
  const debug = jest.fn();
  const warn = jest.fn();
  const error = jest.fn();
  return {
    createLogger: jest.fn(() => ({ info, debug, warn, error })),
    format: {
      combine: jest.fn((...args: any[]) => args),
      timestamp: jest.fn(() => jest.fn()),
      printf: jest.fn((fn: any) => fn),
      errors: jest.fn(() => jest.fn()),
      splat: jest.fn(() => jest.fn())
    },
    transports: { Console: jest.fn() }
  };
});

// Helper to load module fresh for each test
const loadLogger = () => {
  jest.resetModules();
  return require('../src/logging').Logger as typeof import('../src/logging').Logger;
};

describe('Logger utilities', () => {
  afterEach(() => {
    jest.resetModules();
    mcache.clear();
    delete process.env.LOG_LEVEL;
    delete process.env.LOG_LEVEL_test;
    delete process.env._X_AMZN_TRACE_ID;
  });

  it('registers and deregisters AWS request IDs', () => {
    process.env._X_AMZN_TRACE_ID = 'abc';
    const Logger = loadLogger();
    Logger.registerAwsRequestId('req1');
    expect(mcache.get('__SEIZE_CACHE_REQ_ID_abc')).toBe('req1');
    Logger.deregisterRequestId();
    expect(mcache.get('__SEIZE_CACHE_REQ_ID_abc')).toBeUndefined();
  });

  it('returns a singleton logger instance', () => {
    const Logger = loadLogger();
    const first = Logger.get('test');
    const second = Logger.get('test');
    expect(first).toBe(second);
  });

  it('respects global log level environment variable', () => {
    process.env.LOG_LEVEL = 'WARN';
    const Logger = loadLogger();
    const logger = Logger.get('test');
    logger.debug('a');
    logger.info('b');
    logger.warn('c');
    logger.error('d');
    const winston = require('winston');
    const instance = (winston.createLogger as jest.Mock).mock.results[0].value;
    expect(instance.debug).not.toHaveBeenCalled();
    expect(instance.info).not.toHaveBeenCalled();
    expect(instance.warn).toHaveBeenCalledWith('c', []);
    expect(instance.error).toHaveBeenCalledWith('d', []);
  });

  it('allows logger-specific level overrides', () => {
    process.env.LOG_LEVEL_test = 'DEBUG';
    const Logger = loadLogger();
    const logger = Logger.get('test');
    logger.debug('x');
    const winston = require('winston');
    const instance = (winston.createLogger as jest.Mock).mock.results[0].value;
    expect(instance.debug).toHaveBeenCalledWith('x', []);
  });

  it('defaults to INFO when level is invalid', () => {
    process.env.LOG_LEVEL_test = 'SOMETHING';
    const Logger = loadLogger();
    const logger = Logger.get('test2');
    logger.debug('y');
    logger.info('z');
    const winston = require('winston');
    const instance = (winston.createLogger as jest.Mock).mock.results[0].value;
    expect(instance.debug).not.toHaveBeenCalled();
    expect(instance.info).toHaveBeenCalledWith('z', []);
  });
});
