// Publication checks only: canonical parameter vectors do not contact a runtime or host.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const id='provider-event-wake-request-metadata';
const read=async path=>JSON.parse(await readFile(new URL(path,import.meta.url),'utf8'));
const registry=await read('./contract-fixtures/index.json');
const entry=registry.contracts.find(row=>row.id===id);
const schema=await read(`./contract-fixtures/${id}/schemas.json`);
const parent=await read('./contract-fixtures/provider-event-wake/schemas.json');
const ajv=new Ajv({allErrors:true,strict:false});addFormats(ajv);ajv.addSchema(schema);ajv.addSchema(parent);
const metadata=ajv.getSchema(`${schema.$id}#/definitions/metadata`);
const list=ajv.compile({type:'object',additionalProperties:false,maxProperties:0});
const methodSchema={
  'events/list':list,
  'events/subscribe':ajv.getSchema(`${parent.$id}#/definitions/subscribeParams`),
  'events/unsubscribe':ajv.getSchema(`${parent.$id}#/definitions/unsubscribeParams`)
};

test('metadata amendment is approved independently and preserves the parent contract',()=>{
  assert.equal(entry.status,'approved');assert.equal(entry.version,1);assert.equal(entry.fixtures.length,29);
  assert.equal(schema['x-approval'].proposalSha256,'1d91e9ecbfd3e3955cce371ebb21025f60d0835a469819da7fcb90bc5079ad34');
  assert.equal(schema['x-rules'].maxCompleteRequestBytes,65536);
  assert.deepEqual(schema['x-rules'].methods,Object.keys(methodSchema));
  assert.equal(registry.contracts.find(row=>row.id==='provider-event-wake').version,1);
  assert.equal(registry.contracts.find(row=>row.id==='provider-event-wake-discovery').version,1);
});
for(const name of entry.fixtures){
  const fixture=await read(`./contract-fixtures/${id}/${name}`);
  test(`metadata parameter vector: ${fixture.id}`,()=>{
    const params=fixture.params;
    const metaValid=!Object.hasOwn(params,'_meta')||metadata(params._meta);
    const methodParams=Object.fromEntries(Object.entries(params).filter(([key])=>key!=='_meta'));
    const valid=Boolean(metaValid&&methodSchema[fixture.method](methodParams));
    assert.equal(valid,fixture.expected.valid);
    assert.equal(fixture.expected.errorCode,valid?null:-32602);
    if(fixture.method==='events/list')assert.equal(ajv.getSchema(`${schema.$id}#/definitions/listParams`)(params),valid);
  });
}
