import { applyLegacyEnvironmentFallbacks } from './envoi-environment.js';

export const humanConversationMessagingEnabled = (env = process.env) => applyLegacyEnvironmentFallbacks({ ...env }).ENVOI_AUTH_MODE !== 'production';
