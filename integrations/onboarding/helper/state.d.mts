export function createHelper(options: Record<string, any>): Promise<{
  connect(): Promise<Record<string, any>>;
  resume(): Promise<Record<string, any>>;
  status(): Promise<Record<string, any>>;
}>;
