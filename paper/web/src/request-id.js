// randomUUID is limited to secure contexts; getRandomValues also works over HTTP.
export function requestId(source = globalThis.crypto) {
  if (typeof source?.randomUUID === 'function') return source.randomUUID();
  const bytes = new Uint8Array(24);
  source.getRandomValues(bytes);
  return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
}
