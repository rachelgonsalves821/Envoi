import { describe, expect, it } from 'vitest';
import { parseAgentReply } from './bridge';

describe('model reply envelopes', () => {
  it('unwraps whole JSON fences for messages, stopping and structured decisions', () => {
    expect(parseAgentReply('```json\n{"text":"ONBOARDING_OK","intent":"message"}\n```')).toEqual({ text: 'ONBOARDING_OK', intent: 'message' });
    expect(parseAgentReply('```\r\n{"stop":true}\r\n```')).toEqual({ stop: true });
    expect(parseAgentReply('```JSON\n{"text":"Accepted","intent":"accept","decision":{"proposalMessageId":"msg_1"}}\n```'))
      .toMatchObject({ intent: 'accept', decision: { proposalMessageId: 'msg_1' } });
  });
  it('validates fenced objects instead of silently sending invalid structured replies', () => {
    expect(() => parseAgentReply('```json\n{"text":"bad","intent":"message","assetHandle":"../secret"}\n```')).toThrow('invalid asset handle');
    expect(() => parseAgentReply('```json\n{"text":"bad","intent":"message","proposal":{"answer":42}}\n```')).toThrow('invalid proposal');
    expect(() => parseAgentReply('```json\n{broken}\n```')).toThrow('invalid fenced JSON');
  });
  it('preserves ordinary markdown and code and limits plain-text replies', () => {
    for (const text of ['Example:\n```json\n{"text":"quoted"}\n```', '```\nprint("hello")\n```', '```python\nprint("hello")\n```']) {
      expect(parseAgentReply(text)).toEqual({ text, intent: 'message' });
    }
    expect(() => parseAgentReply('x'.repeat(60_001))).toThrow('too long');
  });
});
