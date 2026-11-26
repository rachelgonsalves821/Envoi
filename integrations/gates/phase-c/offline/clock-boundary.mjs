// Child-process clock boundary only. File is created in this run's disposable root.
import { readFileSync } from 'node:fs';
const NativeDate = Date;
const offset = () => {
  const raw = readFileSync(process.env.ENVOI_OFFLINE_CLOCK, 'utf8');
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error('INVALID_SYNTHETIC_CLOCK');
  return Number(raw);
};
globalThis.Date = class extends NativeDate {
  constructor(...args) { super(...(args.length ? args : [NativeDate.now() + offset()])); }
  static now() { return NativeDate.now() + offset(); }
};
