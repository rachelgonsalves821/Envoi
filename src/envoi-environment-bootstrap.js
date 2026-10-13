import { applyLegacyEnvironmentFallbacks, assertNoRetiredEnvironment } from './envoi-environment.js';

assertNoRetiredEnvironment();
applyLegacyEnvironmentFallbacks();
