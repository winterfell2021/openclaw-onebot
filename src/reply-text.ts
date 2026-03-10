function normalizeReplyFragment(value: unknown): string {
  return String(value ?? "").replace(/\r\n/g, "\n");
}

function resolveOverlapLength(previous: string, incoming: string): number {
  const maxLength = Math.min(previous.length, incoming.length);
  for (let length = maxLength; length > 0; length -= 1) {
    if (previous.slice(-length) === incoming.slice(0, length)) {
      return length;
    }
  }
  return 0;
}

export function mergeBufferedReplyText(previous: string, incoming: string): string {
  const next = normalizeReplyFragment(incoming);
  if (!next) return previous;
  if (!previous) return next;
  if (next.includes(previous)) return next;
  if (previous.includes(next)) return previous;

  const overlapLength = resolveOverlapLength(previous, next);
  if (overlapLength > 0) {
    return `${previous}${next.slice(overlapLength)}`;
  }
  return `${previous}${next}`;
}
