import {
  createLogger,
  format,
  Logger as WinstonLogger,
  transports
} from 'winston';

import { loggerContext } from './logger-context';

const { combine, timestamp, printf, errors, splat } = format;

const winstonInstances = new Map<string, WinstonLogger>();

const messageFormat = (loggerName: string) =>
  printf((info) => {
    const splatSym = Symbol.for('splat');
    const extras = (info as any)[splatSym] as unknown[] | undefined;
    const context = loggerContext.get();
    const requestId = context?.requestId ?? '';
    const jwtSub = context?.jwtSub ?? '';

    // pretty print object messages
    if (info.message?.constructor === Object) {
      info.message = JSON.stringify(info.message, null, 2);
    }

    const extrasStr = extras?.length
      ? ' ' +
        extras
          .map((v) =>
            typeof v === 'string'
              ? v
              : (() => {
                  try {
                    return JSON.stringify(v);
                  } catch {
                    return String(v);
                  }
                })()
          )
          .join(' ')
      : '';

    return `[${info.timestamp}] [${requestId}] [${jwtSub}] [${info.level}] [${loggerName}] : ${info.message}${extrasStr}${
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

const LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
const DEFAULT_LEVEL = 'INFO';

export class Logger {
  public static get(name: string): Logger {
    if (!Logger.instances.has(name)) {
      Logger.instances.set(name, new Logger(name));
    }
    return Logger.instances.get(name)!;
  }

  private static readonly instances = new Map<string, Logger>();

  private constructor(public readonly name: string) {}

  info(arg1: any, ...rest: any) {
    if (this.isLevelEnabled('INFO')) {
      getWinstonInstance(this.name).info(arg1, ...rest);
    }
  }

  debug(arg1: any, ...rest: any) {
    if (this.isLevelEnabled('DEBUG')) {
      getWinstonInstance(this.name).debug(arg1, ...rest);
    }
  }

  warn(arg1: any, ...rest: any) {
    if (this.isLevelEnabled('WARN')) {
      getWinstonInstance(this.name).warn(arg1, ...rest);
    }
  }

  error(arg1: any, ...rest: any) {
    if (this.isLevelEnabled('ERROR')) {
      getWinstonInstance(this.name).error(arg1, ...rest);
    }
  }

  private isLevelEnabled(level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'): boolean {
    const loggerLevel =
      process.env[`LOG_LEVEL_${this.name}`]?.toUpperCase() ?? DEFAULT_LEVEL;
    let loggerLevelIndex = LEVELS.indexOf(loggerLevel);
    if (loggerLevelIndex < 0) {
      loggerLevelIndex = 1; // INFO
    }
    return LEVELS.indexOf(level) >= loggerLevelIndex;
  }
}
