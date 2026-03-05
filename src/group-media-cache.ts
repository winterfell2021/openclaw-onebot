import type { ResolvedInboundMedia } from "./inbound-media";

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 200;

interface GroupMediaCacheEntry {
  media: ResolvedInboundMedia;
  updatedAt: number;
}

function cloneResolvedInboundMedia(media: ResolvedInboundMedia): ResolvedInboundMedia {
  return {
    paths: [...media.paths],
    urls: [...media.urls],
    types: [...media.types],
  };
}

export class GroupMentionMediaCache {
  private readonly entries = new Map<string, GroupMediaCacheEntry>();

  constructor(
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
  ) {}

  private toKey(groupId: number, userId: number): string {
    return `${groupId}:${userId}`;
  }

  private isExpired(entry: GroupMediaCacheEntry, now: number): boolean {
    return now - entry.updatedAt > this.ttlMs;
  }

  private cleanup(now: number): void {
    for (const [key, entry] of this.entries.entries()) {
      if (this.isExpired(entry, now)) {
        this.entries.delete(key);
      }
    }

    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.entries.delete(oldestKey);
    }
  }

  record(groupId: number, userId: number, media: ResolvedInboundMedia, now = Date.now()): boolean {
    if (media.paths.length === 0) return false;
    this.cleanup(now);
    this.entries.set(this.toKey(groupId, userId), {
      media: cloneResolvedInboundMedia(media),
      updatedAt: now,
    });
    return true;
  }

  consume(groupId: number, userId: number, now = Date.now()): ResolvedInboundMedia | null {
    this.cleanup(now);
    const key = this.toKey(groupId, userId);
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (this.isExpired(entry, now)) {
      this.entries.delete(key);
      return null;
    }
    this.entries.delete(key);
    return cloneResolvedInboundMedia(entry.media);
  }
}

