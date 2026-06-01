export function normalizeChannelId(value: unknown): string | null {
  const raw = normalizeRawChannelId(value);
  if (!raw) return null;
  const normalized = raw.replace(/^-100/, '').replace(/^-/, '');
  return normalized.length > 0 && normalized !== '0' ? normalized : null;
}

export function normalizeChannelIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of value) {
    const channelId = normalizeChannelId(item);
    if (!channelId || seen.has(channelId)) continue;
    seen.add(channelId);
    normalized.push(channelId);
  }
  return normalized;
}

function normalizeRawChannelId(value: unknown): string | null {
  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? String(value) : null;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  return null;
}
