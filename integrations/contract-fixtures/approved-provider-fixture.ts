import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const pins = {
  'mcp-wake': '32975892945718296a4968a3d6ddbc40ef6d175b',
  'provider-event-wake': 'd920f65cf2ad2ec1933ab92c29d46fbdb4397a7b',
  'provider-gateway-native': 'f56e3c4790ad712f0863f4cfcd85185da58c54ad',
  'provider-connector-tools': '3af8669a907c316b95ff92fa7031a50a654e1a18'
} as const;

/** Read the Lane A-owned source; use the approved Git object before its branch is composed. No fixture copies. */
export function approvedProviderFixture(contract: keyof typeof pins, name: string): any {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error('Invalid fixture name');
  const relative = `test/contract-fixtures/${contract}/${name}.json`;
  const filename = fileURLToPath(new URL(`../../${relative}`, import.meta.url));
  const source = existsSync(filename) ? readFileSync(filename, 'utf8') : execFileSync('git', ['show', `${pins[contract]}:${relative}`], { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
  return JSON.parse(source);
}
