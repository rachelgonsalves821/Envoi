import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { generateRouteAvailabilityValidator, validatorFile, generateRouteEnums, routeEnumsFile } from '../build/route-availability';
import validate from '../src/onboarding/route-availability.validator.mjs';
import schema from '../../test/contract-fixtures/agent-registration/schemas.json';
import { contractRegistry, loadContractFixture } from '../../integrations/contract-fixtures/setup';

const contract = contractRegistry.contracts.find(value => value.id === 'agent-registration')!;
const body = (name: string) => (loadContractFixture(contract, name + '.json') as any).response.body;

describe('CSP-safe canonical route validator', () => {
  it('matches fresh standalone generation from the canonical schema byte for byte', () => {
    expect(readFileSync(validatorFile, 'utf8').replace(/\r\n/g, '\n')).toBe(generateRouteAvailabilityValidator());
  });

  it('agrees with the canonical Ajv validator for fixtures and closed-shape mutations', () => {
    const ajv = new Ajv({ strict: false }); addFormats(ajv); ajv.addSchema(schema);
    const canonical = ajv.getSchema(schema.$id + '#/definitions/routeAvailability')!;
    const values: unknown[] = [null, [], {}, 'routes', ...['routes-disabled', 'routes-available', 'routes-available-rest'].map(body)];
    const valid = body('routes-available');
    for (const key of Object.keys(valid)) {
      const missing = structuredClone(valid); delete missing[key]; values.push(missing);
      for (const invalid of [null, 'true', 1, [], {}]) values.push({ ...structuredClone(valid), [key]: invalid });
    }
    for (const mutate of [
      (value: any) => { value.extra = true; },
      (value: any) => { value.asOf = '2026-10-17'; },
      (value: any) => { value.contract.extra = true; },
      (value: any) => { value.contract.id = 'other'; },
      (value: any) => { value.contract.version = 2; },
      (value: any) => { value.routes[0].extra = true; },
      (value: any) => { delete value.routes[0].available; },
      (value: any) => { value.routes[0].available = 'true'; },
      (value: any) => { value.routes[0].connectionRoute = 'invented'; },
      (value: any) => { value.routes.pop(); },
      (value: any) => { value.routes.push(value.routes[0]); },
      (value: any) => { value.deliveryModes[0].extra = true; },
      (value: any) => { delete value.deliveryModes[0].deliveryMode; },
      (value: any) => { value.deliveryModes[0].available = 1; },
      (value: any) => { value.deliveryModes[0].deliveryMode = 'invented'; },
      (value: any) => { value.deliveryModes.pop(); },
      (value: any) => { value.deliveryModes.push(value.deliveryModes[0]); }
    ]) { const value = structuredClone(valid); mutate(value); values.push(value); }
    for (const value of values) expect(validate(value)).toBe(canonical(value));
    expect(values.length).toBeGreaterThan(50);
  });

  it('executes the generated validator with string code generation disabled', () => {
    const source = readFileSync(validatorFile, 'utf8')
      .replace(/export const validate = [^;]+;/, '')
      .replace(/export default ([^;]+);/, 'const validate = $1;');
    for (const name of ['routes-disabled', 'routes-available', 'routes-available-rest']) {
      expect(runInNewContext(source + '; validate(value);', { value: body(name) },
        { contextCodeGeneration: { strings: false, wasm: false } })).toBe(true);
    }
  });
});


describe('canonical browser route enums', () => {
  it('matches the build output and exports only the two frozen enum lists', () => {
    const generated = generateRouteEnums();
    expect(readFileSync(routeEnumsFile, 'utf8').replace(/\r\n/g, '\n')).toBe(generated);
    const values = runInNewContext(generated.replaceAll('export const ', 'const ')
      + '; ({ connectionRoutes, deliveryModes });', {},
    { contextCodeGeneration: { strings: false, wasm: false } });
    expect(values.connectionRoutes).toEqual(schema.definitions.connectionRoute.enum);
    expect(values.deliveryModes).toEqual(schema.definitions.deliveryMode.enum);
    expect(Object.isFrozen(values.connectionRoutes)).toBe(true);
    expect(Object.isFrozen(values.deliveryModes)).toBe(true);
  });

  it('ignores unrelated stored schema growth and fails closed on invalid enum definitions', () => {
    const expanded = structuredClone(schema);
    Object.assign(expanded.definitions, { storedExample: { secretDescription: 'unused-browser-marker' } });
    expect(generateRouteEnums(expanded)).toBe(generateRouteEnums());
    expect(generateRouteEnums(expanded)).not.toContain('unused-browser-marker');
    for (const name of ['connectionRoute', 'deliveryMode']) {
      for (const value of [undefined, [], [1], 'invalid']) {
        const invalid = structuredClone(schema) as any;
        invalid.definitions[name].enum = value;
        expect(() => generateRouteEnums(invalid)).toThrow('enum is missing or invalid');
      }
    }
  });
});
