import * as Joi from 'joi';

export type ContractOnlyParams = {
  contract: string;
};

export type ContractCardParams = {
  contract: string;
  card_id: string;
};

export type ContractClaimParams = {
  contract: string;
  claim_id: string;
};

export type ProofsPathParams = {
  contract: string;
  card_id: string;
  merkle_root: string;
  address: string;
};

export const ContractAddressSchema = Joi.string()
  .trim()
  .pattern(/^0x[a-fA-F0-9]{40}$/)
  .required()
  .messages({
    'string.pattern.base':
      'contract must be a 0x-prefixed 42-character hex string'
  });

export const ContractOnlyParamsSchema: Joi.ObjectSchema<ContractOnlyParams> =
  Joi.object({
    contract: ContractAddressSchema
  });

export const ContractCardParamsSchema: Joi.ObjectSchema<ContractCardParams> =
  Joi.object({
    contract: ContractAddressSchema,
    card_id: Joi.string().trim().required().pattern(/^\d+$/)
  });

export const ContractClaimParamsSchema: Joi.ObjectSchema<ContractClaimParams> =
  Joi.object({
    contract: ContractAddressSchema,
    claim_id: Joi.string().trim().required().pattern(/^\d+$/)
  });

export const ProofsPathParamsSchema: Joi.ObjectSchema<ProofsPathParams> =
  Joi.object({
    contract: ContractAddressSchema,
    card_id: Joi.string().trim().required().pattern(/^\d+$/),
    merkle_root: Joi.string()
      .trim()
      .pattern(/^0x[a-fA-F0-9]{64}$/)
      .required()
      .messages({
        'string.pattern.base':
          'merkle_root must be a 0x-prefixed 66-character hex string'
      }),
    address: Joi.string()
      .trim()
      .pattern(/^0x[a-fA-F0-9]{40}$/)
      .required()
      .messages({
        'string.pattern.base':
          'address must be a 0x-prefixed 42-character hex string'
      })
  });
