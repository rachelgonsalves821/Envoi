import { describe, expect, it } from 'vitest';
import { validateEnvoiMcpDestination } from './mcp-origin';

describe('xAI scoped MCP token destination', () => {
  it('accepts only the configured public Envoi origin /mcp', () => {
    expect(() => validateEnvoiMcpDestination('https://staging.envoi.example',
      'https://staging.envoi.example/mcp')).not.toThrow();
    for (const destination of [
      'https://other.example/mcp',
      'https://staging.envoi.example:8443/mcp',
      'https://staging.envoi.example/mcp?next=secret',
      'https://user:secret@staging.envoi.example/mcp',
      'https://staging.envoi.example/mcp/other',
      'http://127.0.0.1:8788/mcp',
      'https://localhost/mcp',
    ]) {
      expect(() => validateEnvoiMcpDestination('https://staging.envoi.example', destination))
        .toThrow('configured Envoi origin /mcp');
    }
  });

  it('allows a same-origin loopback relay only in an injected local test', () => {
    expect(() => validateEnvoiMcpDestination('http://127.0.0.1:8788',
      'http://127.0.0.1:8788/mcp', false)).not.toThrow();
    expect(() => validateEnvoiMcpDestination('http://127.0.0.1:8788',
      'http://127.0.0.1:8788/mcp')).toThrow();
    expect(() => validateEnvoiMcpDestination('http://127.0.0.1:8788',
      'http://127.0.0.1:9999/mcp', false)).toThrow();
  });
});
