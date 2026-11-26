import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connectorService } from './service';
import { windowsExecutable } from './windows';

const execute = promisify(execFile);
const decode = (contents: string) => {
  const arguments_ = /<Arguments>([^<]+)<\/Arguments>/.exec(contents)![1].replaceAll('&quot;', '"');
  const encoded = /"-EncodedCommand" "([A-Za-z0-9+/=]+)"/.exec(arguments_);
  expect(encoded, 'Task must launch the reviewed hidden wrapper').not.toBeNull();
  return { encoded: encoded![1], script: Buffer.from(encoded![1], 'base64').toString('utf16le') };
};

describe('Windows connector task launcher', () => {
  it('keeps both parent and child hidden, captures process output and retains periodic single-owner recovery', () => {
    const directory = "D:\\owner's $private & space\\Adam";
    const node = "C:\\Program Files\\Node's $test\\node.exe";
    const task = connectorService(directory, { platform: 'win32', user: 'S-1-5-123', node, env: { SystemRoot: 'C:\\Windows' } });
    const { script } = decode(task.contents);
    expect(task.contents).toContain('powershell.exe</Command>');
    expect(task.contents).toContain('&quot;-WindowStyle&quot; &quot;Hidden&quot;');
    expect(script).toContain('-WindowStyle Hidden');
    expect(script).toContain(node.replaceAll("'", "''"));
    expect(script).toContain(directory.replaceAll("'", "''"));
    expect(script).toContain('-RedirectStandardOutput');
    expect(script).toContain('-RedirectStandardError');
    expect(script).toContain('connector.stdout.log');
    expect(script).toContain('connector.stderr.log');
    expect(script).toContain('connector-supervisor.log');
    expect(script).toContain('WaitForExit()');
    expect(script).toContain('ExitCode');
    expect(task.contents).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
    expect(task.contents).toContain('<Repetition><Interval>PT1M</Interval>');
    expect(script).not.toContain('enrollmentToken');
  });

  it.skipIf(process.platform !== 'win32')('runs only a disposable dummy Node program, preserving arguments, exit status and both launch logs', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "envoi-launcher's $fixture & space-"));
    try {
      const program = path.join(directory, 'connector.mjs');
      await writeFile(program, "process.stdout.write(JSON.stringify(process.argv.slice(2))); process.stderr.write('dummy diagnostic'); process.exitCode=7;");
      const task = connectorService(directory, { platform: 'win32', user: 'S-1-5-123', node: process.execPath });
      const { encoded } = decode(task.contents);
      const run = () => execute(windowsExecutable('powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, timeout: 20_000 });
      const result = await run().catch(error => error);
      expect(result.code).toBe(7);
      expect(JSON.parse(await readFile(path.join(directory, 'connector.stdout.log'), 'utf8'))).toEqual(['start', '--state-dir', directory]);
      expect(await readFile(path.join(directory, 'connector.stderr.log'), 'utf8')).toContain('dummy diagnostic');
      expect(await readFile(path.join(directory, 'connector-supervisor.log'), 'utf8')).toContain('exit=7');
      await writeFile(program, "process.stdout.write('second dummy launch');");
      await run();
      expect(await readFile(path.join(directory, 'connector.stdout.log'), 'utf8')).toContain('second dummy launch');
      expect(await readFile(path.join(directory, 'connector.stdout.log.previous'), 'utf8')).toContain('--state-dir');
    } finally {
      if (path.dirname(path.resolve(directory)) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith('envoi-launcher')) throw new Error('Unsafe fixture cleanup');
      await rm(directory, { recursive: true, force: true });
    }
  });
});
