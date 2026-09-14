import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export function approvedAwsCli(value = process.env.AWS_CLI_PATH) {
  if (!value || !isAbsolute(value))
    throw new Error('Invalid approved AWS CLI path');
  try {
    const executable = realpathSync(value);
    const checkout = realpathSync(
      fileURLToPath(new URL('../../../', import.meta.url))
    );
    const fromCheckout = relative(checkout, executable);
    const outsideCheckout =
      fromCheckout === '..' ||
      fromCheckout.startsWith(`..${sep}`) ||
      isAbsolute(fromCheckout);
    if (
      !outsideCheckout ||
      !['aws', 'aws.exe'].includes(basename(executable).toLowerCase()) ||
      !statSync(executable).isFile()
    )
      throw new Error('Invalid approved AWS CLI path');
    accessSync(executable, constants.X_OK);
    return executable;
  } catch {
    throw new Error('Invalid approved AWS CLI path');
  }
}
