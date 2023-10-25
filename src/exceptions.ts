export abstract class ApiCompliantException extends Error {
  protected constructor(message: string) {
    super(message);
  }

  abstract getStatusCode(): number;
}

export class BadRequestException extends ApiCompliantException {
  constructor(message: string) {
    super(message);
  }

  getStatusCode(): number {
    return 400;
  }
}

export class ForbiddenException extends ApiCompliantException {
  constructor(message: string) {
    super(message);
  }

  getStatusCode(): number {
    return 403;
  }
}

export class NotFoundException extends ApiCompliantException {
  constructor(message: string) {
    super(message);
  }

  getStatusCode(): number {
    return 404;
  }
}

export class UnauthorisedException extends ApiCompliantException {
  constructor(message: string) {
    super(message);
  }

  getStatusCode(): number {
    return 401;
  }
}
