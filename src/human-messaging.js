import { applyEnvoiEnvironmentAliases } from './envoi-environment.js';

export const humanConversationMessagingEnabled = (env = process.env) => applyEnvoiEnvironmentAliases({ ...env }).ENVOI_AUTH_MODE !== 'production';
