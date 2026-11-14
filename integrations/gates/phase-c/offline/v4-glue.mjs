// Reviewed operator excerpts, not reimplementations of their response shapes.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const selected = JSON.parse(await fs.readFile(new URL('./v4-source.json', import.meta.url), 'utf8'));
export const byteDigest = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const digest = v => byteDigest(JSON.stringify(canonical(v)));
const json = async (file, max) => {
  const stat = await fs.lstat(file);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= max, 'BOUNDED_REGULAR_PREPARED_FILE_REQUIRED');
  return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
};

// Only trusted, committed code is compiled. Neither packet data nor test responses
// can supply executable code. Removing `export` is the sole syntax adaptation.
export function glue(overrides = {}, clockDelay = delay) {
  const source = name => (overrides[name] ?? selected.segments[name].source).replaceAll('export ', '');
  const compile = (names, body) => new Function('assert', 'path', 'json', 'digest', 'delay',
    names.map(source).join('\n') + '\n' + body)(assert, path, json, digest, clockDelay);
  return {
    ...compile(['selection'], 'return { effectiveHermesSelection };'),
    ...compile(['scopePredicate'], 'return { bindsNativeScope };'),
    ...compile(['completion'], 'return { terminalResponses, verifyNoActionCanonicalChange };'),
    conductor: compile([], 'return (class {' + source('conductor') + '}).prototype;'),
    scopeCallback: compile(['scopePredicate'], 'return function({probes,role,ctx,prepareFixture,fixtureHooks}) { return ' + source('scopeCallback') + '; };'),
    bounds: compile([], 'return function(controller) {' + source('bounds') + '; return {now, expiry, controlStop}; };'),
    finalization: compile([], 'return function(nativeEnd, decisionWorkId) {' + source('finalization') + '; return nativeSession; };'),
    failureCleanup: compile([], 'return function(ctx,controller,runProgram) {' + source('failureCleanup') + '; return ctx.runProgram(); };'),
    decisionSequence: compile([], 'return async function(c,fixture) { const incoming=(flowId,options)=>c.exactIncoming({flowId,...options}),one=async binding=>(await c.runGroup([binding]))[0];' + source('decisionSequence') + '};')
  };
}

/** Read only: hashes and public excerpts, never import/execute the operator kit. */
export async function verifySelectedKit(root) {
  assert(path.isAbsolute(root), 'KIT_ROOT_MUST_BE_ABSOLUTE');
  const packet = await fs.readFile(path.join(root, 'final-session-v4/prepared-packet-v4.private.json'));
  assert.equal(byteDigest(packet), selected.packetSha256, 'SELECTED_PACKET_CHANGED: select and review a new snapshot');
  const p = JSON.parse(packet);
  assert.equal(p.clientSource, selected.clientSource, 'CLIENT_SOURCE_CHANGED');
  assert.equal(p.serverSource, selected.serverSource, 'SERVER_SOURCE_CHANGED');
  assert.equal(byteDigest(await fs.readFile(path.join(root, 'client/continuation-operator.mjs'))), selected.librarySha256, 'SDK_PACKAGE_CHANGED');
  for (const [name, segment] of Object.entries(selected.segments)) {
    const raw = await fs.readFile(path.join(root, segment.file));
    assert.equal(byteDigest(raw), segment.fileSha256, `V4_FILE_CHANGED: ${segment.file}`);
    const text = raw.toString('utf8').replaceAll('\r\n', '\n'), start = text.indexOf(segment.start), end = text.indexOf(segment.end, start);
    assert(start >= 0 && end > start, `V4_SEAM_MISSING: ${name}`);
    const source = text.slice(start, end) + (name === 'scopeCallback' ? '}' : '');
    assert.equal(byteDigest(source), segment.sha256, `V4_SEAM_CHANGED: ${name}`);
    assert.equal(source, segment.source, `V4_SEAM_MISMATCH: ${name}`);
  }
  return { client: selected.clientSource, server: selected.serverSource, packet: selected.packetSha256 };
}
