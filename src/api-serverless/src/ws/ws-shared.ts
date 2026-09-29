// Dependency-free values shared by transport and persistence; never import ws here.
export const ANON_USER_ID = '$ANONONYMOUS_USER$';

export class SocketNotAvailableException extends Error {
  constructor() {
    super(`Socket is not available`);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
