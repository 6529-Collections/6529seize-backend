import {
  createLogger,
  format,
  Logger as WinstonLogger,
  transports
} from 'winston';

import * as mcache from 'memory-cache';
import { Time } from './time';

const { combine, timestamp, printf, errors, splat } = format;

const REQ_ID_CACHE_TIMEOUT_MS = Time.minutes(15).toMillis();

const winstonInstances = new Map<string, WinstonLogger>();

const reqIdCacheKey = () =>
  `__SEIZE_CACHE_REQ_ID_${process.env._X_AMZN_TRACE_ID}`;

const messageFormat = (loggerName: string) =>
  printf((info) => {
    if (info.message.constructor === Object) {
      info.message = JSON.stringify(info.message, null, 2);
    }
    return `[${
      info.timestamp
    }] : [${loggerName}] : [${info.level.toUpperCase()}] : ${info.message}${
      info.stack ? '\n' + info.stack : ''
    }`;
  });

function getWinstonInstance(name: string): WinstonLogger {
  if (!winstonInstances.has(name)) {
    winstonInstances.set(
      name,
      createLogger({
        level:
          process.env[`LOG_LEVEL_${name}`] ?? process.env.LOG_LEVEL ?? 'info',
        format: combine(
          timestamp({
            format: 'YYYY-MM-DD hh:mm:ss.SSS A'
          }),
          splat(),
          messageFormat(name),
          errors({ stack: true })
        ),
        transports: [new transports.Console()]
      })
    );
  }
  return winstonInstances.get(name)!;
}

export class Logger {
  public static registerAwsRequestId(requestId?: string) {
    if (requestId) {
      mcache.put(reqIdCacheKey(), requestId, REQ_ID_CACHE_TIMEOUT_MS);
    }
  }

  public static deregisterRequestId() {
    mcache.del(reqIdCacheKey());
  }

  public static get(name: string): Logger {
    if (!Logger.instances.has(name)) {
      Logger.instances.set(name, new Logger(name));
    }
    return Logger.instances.get(name)!;
  }

  private static readonly instances = new Map<string, Logger>();

  private constructor(private readonly name: string) {}

  info(arg1: any, ...rest: any) {
    getWinstonInstance(this.name).info(arg1, rest);
  }

  debug(arg1: any, ...rest: any) {
    getWinstonInstance(this.name).debug(arg1, rest);
  }

  warn(arg1: any, ...rest: any) {
    getWinstonInstance(this.name).warn(arg1, rest);
  }

  error(arg1: any, ...rest: any) {
    getWinstonInstance(this.name).error(arg1, rest);
  }
}
