export type Mock<T> = jest.Mocked<T>;

export function mock<T>(_clazz?: abstract new (...args: any[]) => T): Mock<T> {
  const target: Record<PropertyKey, unknown> = {};

  return new Proxy(target, {
    get(currentTarget, property, receiver) {
      if (
        property === 'then' ||
        property === 'catch' ||
        property === 'finally' ||
        property === Symbol.toStringTag
      ) {
        return undefined;
      }

      if (!Reflect.has(currentTarget, property)) {
        Reflect.set(currentTarget, property, jest.fn(), receiver);
      }

      return Reflect.get(currentTarget, property, receiver);
    },
    set(currentTarget, property, value, receiver) {
      return Reflect.set(currentTarget, property, value, receiver);
    }
  }) as Mock<T>;
}
