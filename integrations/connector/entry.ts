import { connectorMain } from './cli';
import { connectorErrorMessage } from './error';

connectorMain().catch(error => {
  process.stderr.write(`${connectorErrorMessage(error)}\n`);
  process.exitCode = 1;
});
