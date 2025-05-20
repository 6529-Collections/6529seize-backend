import { ApiCreateDropRequest } from '../generated/models/ApiCreateDropRequest';
import { createHash } from 'crypto';

export class DropHasher {
  public hash({
    drop,
    termsOfService
  }: {
    drop: ApiCreateDropRequest;
    termsOfService: string | null;
  }): string {
    const obj: any = {
      ...drop
    };
    if (termsOfService) {
      obj.terms_of_service = termsOfService;
    }
    delete obj.signature;
    const serialisedObj = this.canonicalJSONStringify(obj);
    return createHash("sha256").update(serialisedObj).digest("hex");
  }

  private canonicalJSONStringify(obj: any): string {
    if (typeof obj !== 'object' || obj === null) {
      return JSON.stringify(obj);
    }

    if (Array.isArray(obj)) {
      const items = obj.map((item) => this.canonicalJSONStringify(item));
      return `[${items.join(',')}]`;
    }

    const keys = Object.keys(obj).sort();
    const keyValuePairs = keys
      .filter((it) => obj[it] !== undefined)
      .map((key) => {
        const valueString = this.canonicalJSONStringify(obj[key]);
        return `${JSON.stringify(key)}:${valueString}`;
      });
    return `{${keyValuePairs.join(',')}}`;
  }
}

export const dropHasher = new DropHasher();
