import { describe, expect, it } from 'vitest';
import { webhookSecret } from './webhook-secret';

describe('private webhook secret optional Base64 padding', () => {
  it.each([24, 25, 31, 32, 63, 64])('accepts padded and unpadded canonical encodings for %s decoded bytes', length => {
    const bytes = Buffer.alloc(length, 0x51);
    const padded = `whsec_${bytes.toString('base64')}`;
    const unpadded = padded.replace(/=+$/, '');
    expect(webhookSecret(padded).canonical).toBe(padded);
    expect(webhookSecret(unpadded).canonical).toBe(padded);
    expect(Buffer.from(webhookSecret(unpadded).bytes)).toEqual(bytes);
  });
  it.each([
    `whsec_${Buffer.alloc(23).toString('base64')}`,
    `whsec_${Buffer.alloc(65).toString('base64')}`,
    `whsec_${Buffer.alloc(31).toString('base64').replace(/==$/, '=')}`,
    `whsec_${Buffer.alloc(32).toString('base64')}=`,
    `whsec_${Buffer.alloc(32).toString('base64').replace(/A=$/, 'B=')}`,
    `whsec_${Buffer.alloc(32).toString('base64')}\n`,
    'whsec_@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
    'whsec_A'
  ])('rejects invalid lengths, partial/extra padding, noncanonical bits and whitespace (%s)', secret => {
    expect(() => webhookSecret(secret)).toThrow('A private 24–64-byte webhook secret is required');
  });
});
