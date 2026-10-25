/** Private host custody only. Accept canonical Base64 with either complete padding or no padding. */
export function webhookSecret(value: unknown): { bytes: Uint8Array; canonical: string } {
  const invalid = () => new TypeError('A private 24–64-byte webhook secret is required');
  if (typeof value !== 'string' || value.length > 94 || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(value)) throw invalid();
  const encoded = value.slice(6);
  let decoded: string;
  try { decoded = atob(encoded); } catch { throw invalid(); }
  const canonical = btoa(decoded);
  if (decoded.length < 24 || decoded.length > 64 || (encoded !== canonical && encoded !== canonical.replace(/=+$/, ''))) throw invalid();
  return { bytes: Uint8Array.from(decoded, character => character.charCodeAt(0)), canonical: `whsec_${canonical}` };
}
