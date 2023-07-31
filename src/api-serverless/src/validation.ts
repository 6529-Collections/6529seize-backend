import { ethers } from 'ethers';
import * as Joi from 'joi';
import { hashMessage } from '@ethersproject/hash';
import { areEqualAddresses } from '../../helpers';

const rememeSchema = Joi.object({
  address: Joi.string().required(),
  signature: Joi.string().required(), // Add a comma after this line
  rememe: Joi.object({
    contract: Joi.string().required(),
    token_ids: Joi.array().items(Joi.string()).required(),
    references: Joi.array().items(Joi.number()).required()
  })
});

export function validateRememeBody(req: any, res: any, next: any) {
  if (!req.body) {
    console.error(
      new Date(),
      `[API]`,
      '[REMEMES ADD]',
      '[ERROR Empty request body]'
    );
    res.status(400).json({ error: 'Empty request body' });
    return;
  }

  console.log('req.body', req.body);

  const { error, value } = rememeSchema.validate(req.body);
  console.log(error, value, 'error and value');

  if (error) {
    console.error(
      new Date(),
      `[API]`,
      '[REMEMES ADD]',
      `[ERROR Invalid request body ${error.message}`
    );
    res.status(400).json({ error: `Invalid request body: ${error.message}` });
  } else if (!validateSignature(value.address, value.signature, value.rememe)) {
    res.status(400).json({ error: 'Invalid Signature' });
  } else {
    req.validatedBody = value;
    next();
  }
}

function validateSignature(
  address: string,
  signature: string,
  rememe: { contract: string; id: number; meme_references: number[] }
) {
  console.log('JSON.stringify(rememe)', JSON.stringify(rememe));
  const verifySigner = ethers.utils.recoverAddress(
    hashMessage(JSON.stringify(rememe)),
    signature
  );

  return areEqualAddresses(address, verifySigner);
}
