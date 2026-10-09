// Keep already-deployed SINALOA_* settings usable while operators migrate to ENVOI_*.
// Conflicting aliases must fail closed rather than silently changing a secret or policy.
export function applyEnvoiEnvironmentAliases(env = process.env) {
  const suffixes = new Set();
  for (const key of Object.keys(env)) {
    if (key.startsWith('ENVOI_')) suffixes.add(key.slice('ENVOI_'.length));
    if (key.startsWith('SINALOA_')) suffixes.add(key.slice('SINALOA_'.length));
  }
  for (const suffix of suffixes) {
    const current = `ENVOI_${suffix}`;
    const legacy = `SINALOA_${suffix}`;
    const currentValue = env[current];
    const legacyValue = env[legacy];
    if (currentValue !== undefined && legacyValue !== undefined && currentValue !== legacyValue) {
      throw new Error(`Conflicting Envoi environment aliases: ${current} and ${legacy}`);
    }
    if (currentValue === undefined && legacyValue !== undefined) env[current] = legacyValue;
    if (legacyValue === undefined && currentValue !== undefined) env[legacy] = currentValue;
  }
  return env;
}
