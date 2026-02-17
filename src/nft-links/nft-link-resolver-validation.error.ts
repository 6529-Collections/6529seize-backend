import { BadRequestException } from '@/exceptions';

export class NftLinkResolverValidationError extends BadRequestException {
  constructor(message: string) {
    super(message);
  }
}
