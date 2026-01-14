export function genIdempotencyKey(label?: string): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  const prefix = label ? `key-${label}` : "key";
  return `${prefix}-${ts}-${rand}`;
}
