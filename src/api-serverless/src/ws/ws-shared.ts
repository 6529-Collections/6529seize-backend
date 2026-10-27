// Dependency-free values shared by transport and persistence; never import ws here.
export const ANON_USER_ID = '$ANONONYMOUS_USER$';

export const DURABLE_UPDATES_CAPABILITY = 'durable_updates_v1';
export const DELIVERY_CAPABILITY_QUERY = 'delivery_capability';
export function supportsDurableUpdates(value: unknown): boolean {
  return value === DURABLE_UPDATES_CAPABILITY;
}

export class SocketNotAvailableException extends Error {
  constructor() {
    super(`Socket is not available`);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
