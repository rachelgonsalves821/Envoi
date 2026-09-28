import crypto from 'node:crypto';

const canonicalize = value => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  return value;
};

export function validateIdempotencyKey(value, { required = false } = {}) {
  if (value == null || value === '') {
    if (required) throw Object.assign(new TypeError('Idempotency-Key header is required'), { statusCode: 400 });
    return null;
  }
  if (Array.isArray(value) || typeof value !== 'string' || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw Object.assign(new TypeError('Idempotency key is invalid'), { statusCode: 400 });
  }
  return value;
}

export function semanticDigest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

export function scopedIdempotencyPath(namespace, tenantId, principalId, key) {
  const safeKey = validateIdempotencyKey(key, { required: true });
  const scope = crypto.createHash('sha256').update(`${tenantId}\u0000${principalId}`).digest('hex');
  const keyHash = crypto.createHash('sha256').update(safeKey).digest('hex');
  return `idempotency/${namespace}/${scope}/${keyHash}.json`;
}

export function replayResponse(record, { principalId, requestDigest }) {
  if (!record) return null;
  if (record.principalId !== principalId || record.requestDigest !== requestDigest) {
    throw Object.assign(new Error('Idempotency key was already used for a different request'), { statusCode: 409 });
  }
  return record.response;
}

export async function claimIdempotency(store, path, { principalId, requestDigest, createdAt }) {
  const inspect = record => {
    const response = replayResponse(record, { principalId, requestDigest });
    if (response) return { claimed: false, replay: response };
    throw Object.assign(new Error('An identical request with this idempotency key is still in progress'), { statusCode: 409 });
  };
  const existing = await store.getJson(path);
  if (existing) return inspect(existing);
  const claim = { principalId, requestDigest, status: 'processing', response: null, createdAt };
  if (await store.putJsonIfAbsent(path, claim)) return { claimed: true, replay: null };
  return inspect(await store.getJson(path));
}

export async function completeIdempotency(store, path, { principalId, requestDigest, response, createdAt }) {
  await store.putJson(path, { principalId, requestDigest, status: 'completed', response, createdAt });
}
