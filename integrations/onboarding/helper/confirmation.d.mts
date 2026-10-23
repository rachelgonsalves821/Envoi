export function nativeConfirmation(details: Record<string, any>, options?: {
  input?: NodeJS.ReadStream; output?: NodeJS.WriteStream; now?: () => number;
}): Promise<boolean | null>;
