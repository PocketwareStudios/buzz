/**
 * Where the reader was in each channel when they left it, on this device.
 *
 * A channel's read frontier only says "read up to" and advances as soon as
 * the channel is viewed, so it cannot bring a reader back to a post they had
 * not finished. This remembers the post at the top of the viewport (and its
 * offset) per channel, so reopening the channel returns there. It is local
 * and best-effort: storage failures just mean nothing is remembered.
 */

const STORAGE_KEY = "buzz-reading-positions.v1";
/** Most recently left channels kept; older entries are dropped. */
export const MAX_READING_POSITIONS = 200;

export type ReadingPosition = { messageId: string; topOffset: number };

type StoredPosition = ReadingPosition & { savedAt: number };

function readAll(): Record<string, StoredPosition> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const entries: Record<string, StoredPosition> = {};
    for (const [channelId, value] of Object.entries(parsed)) {
      const entry = value as Partial<StoredPosition> | null;
      if (
        entry &&
        typeof entry.messageId === "string" &&
        typeof entry.topOffset === "number" &&
        Number.isFinite(entry.topOffset) &&
        typeof entry.savedAt === "number"
      ) {
        entries[channelId] = entry as StoredPosition;
      }
    }
    return entries;
  } catch {
    return {};
  }
}

export function readReadingPosition(channelId: string): ReadingPosition | null {
  const entry = readAll()[channelId];
  return entry
    ? { messageId: entry.messageId, topOffset: entry.topOffset }
    : null;
}

/** Remember `position` for the channel, or forget it (null: left at the floor). */
export function writeReadingPosition(
  channelId: string,
  position: ReadingPosition | null,
  now: number = Date.now(),
): void {
  try {
    const entries = readAll();
    if (position) {
      entries[channelId] = { ...position, savedAt: now };
    } else if (channelId in entries) {
      delete entries[channelId];
    } else {
      return;
    }
    const kept = Object.entries(entries)
      .sort(([, left], [, right]) => right.savedAt - left.savedAt)
      .slice(0, MAX_READING_POSITIONS);
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(Object.fromEntries(kept)),
    );
  } catch {
    // Best-effort: an unavailable store just means no remembered position.
  }
}
