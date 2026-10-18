import { EnvoiError } from '../../sdk/typescript/src/index';

export function assertOpenClawScopedAdmission(env: NodeJS.ProcessEnv = process.env) {
  if (env.ENVOI_SCOPED_TOOLS !== undefined && env.ENVOI_SCOPED_TOOLS !== 'true' && env.ENVOI_SCOPED_TOOLS !== 'false') {
    throw new TypeError('ENVOI_SCOPED_TOOLS must be true or false');
  }
  if (env.ENVOI_SCOPED_TOOLS === 'true') {
    throw new EnvoiError('OpenClaw scoped mode is unavailable until exclusive Gateway tool access is verified. No work was claimed. Do not bypass this check with legacy mode.',
      undefined, 'SCOPED_PROVIDER_ISOLATION_UNAVAILABLE');
  }
}
