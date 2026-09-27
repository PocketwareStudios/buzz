/**
 * The newest post a reader has had on screen in each channel, on this device.
 *
 * Opening a channel marks it read in its read state, so the sidebar's count
 * for the open channel is the posts after this "seen" frontier instead. The
 * frontier only moves forward: scrolling back up never makes posts count
 * again. Best-effort local storage; failures just forget the frontier.
 */

const STORAGE_KEY = "buzz-seen-frontiers.v1";
/** Most recently updated channels kept; older entries are dropped. */
export const MAX_SEEN_FRONTIERS = 200;

export type SeenFrontier = { createdAt: number; id: string };

type StoredFrontier = SeenFrontier & { savedAt: number };

/** Whether `a` is later in the timeline than `b` (time, then id). */
export function isAfterFrontier(a: SeenFrontier, b: SeenFrontier): boolean {
  return (
    a.createdAt > b.createdAt || (a.createdAt === b.createdAt && a.id > b.id)
  );
}

function readAll(): Record<string, StoredFrontier> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const entries: Record<string, StoredFrontier> = {};
    for (const [channelId, value] of Object.entries(parsed)) {
      const entry = value as Partial<StoredFrontier> | null;
      if (
        entry &&
        typeof entry.id === "string" &&
        typeof entry.createdAt === "number" &&
        Number.isFinite(entry.createdAt) &&
        typeof entry.savedAt === "number"
      ) {
        entries[channelId] = entry as StoredFrontier;
      }
    }
    return entries;
  } catch {
    return {};
  }
}

export function readSeenFrontier(channelId: string): SeenFrontier | null {
  const entry = readAll()[channelId];
  return entry ? { createdAt: entry.createdAt, id: entry.id } : null;
}

export function writeSeenFrontier(
  channelId: string,
  frontier: SeenFrontier,
  now: number = Date.now(),
): void {
  try {
    const entries = readAll();
    const current = entries[channelId];
    // Forward only, even across windows writing the same channel.
    if (current && !isAfterFrontier(frontier, current)) return;
    entries[channelId] = { ...frontier, savedAt: now };
    const kept = Object.entries(entries)
      .sort(([, left], [, right]) => right.savedAt - left.savedAt)
      .slice(0, MAX_SEEN_FRONTIERS);
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(Object.fromEntries(kept)),
    );
  } catch {
    // Best-effort: an unavailable store just forgets the frontier.
  }
}
