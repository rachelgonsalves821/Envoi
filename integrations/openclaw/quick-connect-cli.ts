import { quickConnectMain } from './quick-connect';
import { QuickConnectError } from './quick-connect-error';
import { OpenClawSetupError } from './quick-connect-config';
import { QuickConnectHandoffError } from '../../sdk/typescript/src/quick-connect';

quickConnectMain().catch(error => {
  // Only our actionable diagnostics may be emitted. Provider bodies/credentials never belong here.
  const message = error instanceof QuickConnectError || error instanceof OpenClawSetupError || error instanceof QuickConnectHandoffError
    ? error.message : 'Setup could not finish. Check local OpenClaw configuration, connectivity and the saved Sinaloa connection; run --help for recovery options';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
