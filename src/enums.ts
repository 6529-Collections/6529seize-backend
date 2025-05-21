export enum TokenType {
  ERC721 = 'ERC721',
  ERC1155 = 'ERC1155'
}

export class Enums {
  public resolve<T extends object>(
    enumObj: T,
    value?: string
  ): T[keyof T] | undefined {
    const normalizedValue = value?.toLowerCase();

    for (const enumKey of Object.keys(enumObj)) {
      // Use type assertion to assure TypeScript that toString can be called
      const enumValue = enumObj[enumKey as keyof T] as any;

      if (enumValue.toString().toLowerCase() === normalizedValue) {
        return enumObj[enumKey as keyof T];
      }
    }

    return undefined;
  }

  public resolveOrThrow<T extends object>(
    enumObj: T,
    value?: string
  ): T[keyof T] {
    const resolvedValue = this.resolve(enumObj, value);
    if (resolvedValue) {
      return resolvedValue;
    }
    throw new Error(`Invalid enum value: ${value}`);
  }
}

export const enums = new Enums();
