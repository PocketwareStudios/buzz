/**
 * Storage for a per-channel boolean preference (mute, star, …) that is kept
 * in localStorage and synced across the user's devices.
 *
 * Every flag shares one payload shape, `{ version: 1, channels: { <id>: {
 * <field>: boolean, updatedAt } } }`, differing only in the field name and
 * the storage key. Entries merge per channel by `updatedAt` (last writer
 * wins), and the store is bounded to the most recently updated entries.
 */

export const MAX_CHANNEL_FLAG_ENTRIES = 500;

export type ChannelFlagEntry<F extends string> = Record<F, boolean> & {
  updatedAt: number;
};

export type ChannelFlagStore<F extends string> = {
  version: 1;
  channels: Record<string, ChannelFlagEntry<F>>;
};

export type ChannelFlagStorage<F extends string> = {
  field: F;
  DEFAULT_STORE: ChannelFlagStore<F>;
  storageKey: (pubkey: string) => string;
  parsePayload: (json: unknown) => ChannelFlagStore<F> | null;
  readStore: (pubkey: string) => ChannelFlagStore<F>;
  boundStore: (
    store: ChannelFlagStore<F>,
    preservedKey?: string,
  ) => ChannelFlagStore<F>;
  writeStore: (pubkey: string, store: ChannelFlagStore<F>) => boolean;
  mergeStores: (
    local: ChannelFlagStore<F>,
    remote: ChannelFlagStore<F>,
  ) => ChannelFlagStore<F>;
  flaggedChannelIds: (store: ChannelFlagStore<F>) => Set<string>;
};

/**
 * Build the storage functions for one flag.
 *
 * `field` is the entry's boolean key on the wire (`"muted"`, `"starred"`), and
 * `storageKeyPrefix` its localStorage key before `:<pubkey>`. Both are part of
 * the persisted format: changing either orphans existing preferences.
 */
export function createChannelFlagStorage<F extends string>({
  field,
  storageKeyPrefix,
}: {
  field: F;
  storageKeyPrefix: string;
}): ChannelFlagStorage<F> {
  const DEFAULT_STORE: ChannelFlagStore<F> = Object.freeze({
    version: 1,
    channels: {},
  });

  function storageKey(pubkey: string): string {
    return `${storageKeyPrefix}:${pubkey}`;
  }

  function isEntry(value: unknown): value is ChannelFlagEntry<F> {
    if (typeof value !== "object" || value === null) return false;
    const entry = value as Record<string, unknown>;
    return (
      typeof entry[field] === "boolean" &&
      typeof entry.updatedAt === "number" &&
      Number.isFinite(entry.updatedAt) &&
      entry.updatedAt >= 0
    );
  }

  function boundStore(
    store: ChannelFlagStore<F>,
    preservedKey?: string,
  ): ChannelFlagStore<F> {
    const preservedEntry =
      preservedKey === undefined ? undefined : store.channels[preservedKey];
    const entries = Object.entries(store.channels).filter(
      ([channelId]) => channelId !== preservedKey,
    );
    if (entries.length + (preservedEntry ? 1 : 0) <= MAX_CHANNEL_FLAG_ENTRIES)
      return store;
    entries.sort(([leftId, left], [rightId, right]) => {
      if (left.updatedAt !== right.updatedAt)
        return left.updatedAt - right.updatedAt;
      return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    });
    const retainedEntries = entries.slice(
      -(MAX_CHANNEL_FLAG_ENTRIES - (preservedEntry ? 1 : 0)),
    );
    if (preservedEntry && preservedKey !== undefined) {
      retainedEntries.push([preservedKey, preservedEntry]);
    }
    return {
      ...store,
      channels: Object.fromEntries(retainedEntries),
    };
  }

  function parsePayload(json: unknown): ChannelFlagStore<F> | null {
    if (typeof json !== "object" || json === null) return null;
    const obj = json as Record<string, unknown>;
    if (obj.version !== 1) return null;
    const channels: Record<
      string,
      ChannelFlagEntry<F>
    > = typeof obj.channels === "object" &&
    obj.channels !== null &&
    !Array.isArray(obj.channels)
      ? Object.fromEntries(
          Object.entries(obj.channels as Record<string, unknown>).filter(
            (entry): entry is [string, ChannelFlagEntry<F>] =>
              isEntry(entry[1]),
          ),
        )
      : {};
    return boundStore({ version: 1, channels });
  }

  function readStore(pubkey: string): ChannelFlagStore<F> {
    try {
      const raw = window.localStorage.getItem(storageKey(pubkey));
      if (!raw) {
        return DEFAULT_STORE;
      }
      const parsed = JSON.parse(raw);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        parsed.version !== 1
      ) {
        return DEFAULT_STORE;
      }
      return parsePayload(parsed) ?? DEFAULT_STORE;
    } catch {
      return DEFAULT_STORE;
    }
  }

  function writeStore(pubkey: string, store: ChannelFlagStore<F>): boolean {
    try {
      window.localStorage.setItem(
        storageKey(pubkey),
        JSON.stringify(boundStore(store)),
      );
      return true;
    } catch {
      return false;
    }
  }

  function mergeStores(
    local: ChannelFlagStore<F>,
    remote: ChannelFlagStore<F>,
  ): ChannelFlagStore<F> {
    const allIds = new Set([
      ...Object.keys(local.channels),
      ...Object.keys(remote.channels),
    ]);
    const merged: Record<string, ChannelFlagEntry<F>> = {};
    for (const id of allIds) {
      const l = local.channels[id];
      const r = remote.channels[id];
      if (l && r) {
        merged[id] = l.updatedAt >= r.updatedAt ? l : r;
      } else {
        merged[id] = (l ?? r) as ChannelFlagEntry<F>;
      }
    }
    return boundStore({ version: 1, channels: merged });
  }

  function flaggedChannelIds(store: ChannelFlagStore<F>): Set<string> {
    return new Set(
      Object.entries(store.channels)
        .filter(([, entry]) => entry[field])
        .map(([id]) => id),
    );
  }

  return {
    field,
    DEFAULT_STORE,
    storageKey,
    parsePayload,
    readStore,
    boundStore,
    writeStore,
    mergeStores,
    flaggedChannelIds,
  };
}
