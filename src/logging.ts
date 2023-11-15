import {
  createLogger,
  format,
  Logger as WinstonLogger,
  transports
} from 'winston';

const { combine, timestamp, printf, errors, splat } = format;

const winstonInstances = new Map<string, WinstonLogger>();

const messageFormat = (loggerName: string) =>
  printf((info) => {
    if (info.message.constructor === Object) {
      info.message = JSON.stringify(info.message, null, 2);
    }
    return `[${info.timestamp}] [${process.env.AWS_REQUEST_ID ?? '-'}] [${
      info.level
    }] [${loggerName}] : ${info.message}${info.stack ? '\n' + info.stack : ''}`;
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
  private static readonly instances = new Map<string, Logger>();

  public static get(name: string): Logger {
    if (!Logger.instances.has(name)) {
      Logger.instances.set(name, new Logger(name));
    }
    return Logger.instances.get(name)!;
  }
  private constructor(private readonly name: string) {}

  info(arg1: any, ...rest: any) {
    getWinstonInstance(this.name).info(arg1, rest);
  }

  debug(arg1: any, ...rest: any) {
    getWinstonInstance(this.name).debug(arg1, rest);
  }

  warn(arg1: any, ...rest: any) {
    getWinstonInstance(this.name).debug(arg1, rest);
  }

  error(arg1: any, ...rest: any) {
    getWinstonInstance(this.name).debug(arg1, rest);
  }
}
