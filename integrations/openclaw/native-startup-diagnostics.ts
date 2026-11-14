/** Diagnostic vocabulary only: never serialize native exceptions, config, paths or credentials. */
export const NATIVE_STARTUP_STAGES = Object.freeze([
 'unknown','environment','bootstrap','authorization','private-paths','source-validation',
 'import-host','import-core-host','import-runtime-host','import-observer','import-config','import-plugins',
 'exports','configuration','owner','observer-installation','import-server','gateway-start','gateway-settle','readiness','close',
] as const);
export type NativeStartupStage = typeof NATIVE_STARTUP_STAGES[number];
export const NATIVE_STARTUP_REASONS = Object.freeze([
 'NATIVE_STARTUP_UNCLASSIFIED','SINGLE_OWNED_NATIVE_START_REQUIRED','OWNED_NATIVE_PARENT_REQUIRED',
 'ACTUAL_RESTRICTED_NATIVE_ENVIRONMENT_REQUIRED','ACTUAL_RESTRICTED_NATIVE_CONFIGURATION_REQUIRED',
 'NATIVE_DEADLINE_EXPIRED','REVIEWED_NATIVE_PRIVATE_PATH_REQUIRED','NEW_NATIVE_CHILD_PATH_SELECTION_REQUIRED',
 'EXACT_NATIVE_BOOTSTRAP_REQUIRED','REVIEWED_COMPLETE_NATIVE_CODE_COPY_REQUIRED','REVIEWED_NATIVE_SOURCE_ADOPTION_REQUIRED',
 'EXACT_NATIVE_OBSERVER_EXPORTS_REQUIRED','ACTUAL_NATIVE_GATE_INSTALLATION_REQUIRED','EXACT_NATIVE_GATEWAY_EXPORT_REQUIRED',
 'NATIVE_TRANSPORT_HOST_REPLACED','ACTUAL_NATIVE_TRANSPORT_DRAIN_REQUIRED','CLOSED_NATIVE_PROCESS_ENDED',
 'OWNED_NATIVE_BOOTSTRAP_TIMEOUT',
 'INVALID_CONFIG','ENOENT','EACCES','EPERM','EADDRINUSE','EADDRNOTAVAIL','MODULE_NOT_FOUND','ERR_MODULE_NOT_FOUND','ERR_PACKAGE_PATH_NOT_EXPORTED',
] as const);
export type NativeStartupReason = typeof NATIVE_STARTUP_REASONS[number];
export interface NativeStartupDiagnostic {readonly version:1; readonly stage:NativeStartupStage; readonly reason:NativeStartupReason;}
const stages = new Set<string>(NATIVE_STARTUP_STAGES), reasons = new Set<string>(NATIVE_STARTUP_REASONS);
export function isNativeStartupStage(value:unknown):value is NativeStartupStage {
 return typeof value==='string'&&stages.has(value);
}
const tagged = new WeakMap<object,NativeStartupStage>();
const object = (value:unknown):value is object => value !== null && (typeof value === 'object' || typeof value === 'function');
// Data properties only: arbitrary exception getters/toJSON/cause trees are never evaluated.
function own(value:unknown,key:string):unknown {if(!object(value))return;try{return Object.getOwnPropertyDescriptor(value,key)?.value;}catch{return;}}
export function tagNativeStartupFailure(error:unknown,stage:NativeStartupStage):unknown {
 const safeStage=stages.has(stage)?stage:'unknown';
 if(object(error)) {if(!tagged.has(error))tagged.set(error,safeStage);return error;}
 const wrapped = new Error('NATIVE_STARTUP_UNCLASSIFIED');tagged.set(wrapped,safeStage);return wrapped;
}
export function nativeStartupDiagnostic(error:unknown,fallback:NativeStartupStage='unknown'):NativeStartupDiagnostic {
 const code=own(error,'code'),message=own(error,'message');
 const reason=typeof code==='string'&&reasons.has(code)?code:typeof message==='string'&&reasons.has(message)?message:'NATIVE_STARTUP_UNCLASSIFIED';
 const stage=object(error)?tagged.get(error)??fallback:fallback;
 return Object.freeze({version:1,stage:stages.has(stage)?stage:'unknown',reason:reason as NativeStartupReason});
}
/** Revalidate even a nonce-authenticated child. Reject extra fields and unknown vocabulary. */
export function readNativeStartupDiagnostic(value:unknown):NativeStartupDiagnostic {
 const fallback=Object.freeze({version:1,stage:'unknown',reason:'NATIVE_STARTUP_UNCLASSIFIED'} as const);
 if(!object(value))return fallback;
 try {if(Object.keys(value).sort().join(',')!=='reason,stage,version')return fallback;}catch{return fallback;}
 const version=own(value,'version'),stage=own(value,'stage'),reason=own(value,'reason');
 if(version!==1||typeof stage!=='string'||!stages.has(stage)||typeof reason!=='string'||!reasons.has(reason))return fallback;
 return Object.freeze({version:1,stage:stage as NativeStartupStage,reason:reason as NativeStartupReason});
}
export function ownedNativeStartupError(value:unknown):Error {
 const diagnostic=readNativeStartupDiagnostic(value);
 return Object.assign(new Error(`OWNED_NATIVE_CHILD_FAILED (${diagnostic.stage}:${diagnostic.reason})`),{code:'OWNED_NATIVE_CHILD_FAILED',nativeStartupDiagnostic:diagnostic});
}
