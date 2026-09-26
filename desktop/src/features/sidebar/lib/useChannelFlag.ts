import * as React from "react";

import { relayClient } from "@/shared/api/relayClient";
import type { ChannelFlagEntry, ChannelFlagStore } from "./channelFlagStorage";
import {
  ChannelFlagSyncManager,
  type ChannelFlagSyncSpec,
  type RemoteChannelFlags,
} from "./channelFlagSync";

/**
 * Local-first state for one synced per-channel flag: reads localStorage,
 * follows other windows through `storage` events, and reconciles with the
 * encrypted relay blob on mount, live updates and reconnects.
 *
 * `spec` should be a module-level constant: a new identity rebuilds the sync
 * manager.
 */
export function useChannelFlag<F extends string>(
  spec: ChannelFlagSyncSpec<F>,
  pubkey: string | undefined,
  relayUrl?: string,
): {
  flaggedChannelIds: Set<string>;
  setFlag: (channelId: string, value: boolean) => void;
} {
  const { storage } = spec;
  const [store, setStore] = React.useState<ChannelFlagStore<F>>(() => {
    if (!pubkey) {
      return storage.DEFAULT_STORE;
    }
    return storage.readStore(pubkey);
  });

  const managerRef = React.useRef<ChannelFlagSyncManager<F> | null>(null);
  const lastAppliedRemoteTs = React.useRef(0);
  const lastAppliedEventId = React.useRef("");

  React.useEffect(() => {
    if (!pubkey || !relayUrl) {
      setStore(storage.DEFAULT_STORE);
      lastAppliedRemoteTs.current = 0;
      lastAppliedEventId.current = "";
      return;
    }
    setStore(storage.readStore(pubkey));
    lastAppliedRemoteTs.current = 0;
    lastAppliedEventId.current = "";
    managerRef.current = new ChannelFlagSyncManager(spec, pubkey, relayUrl);
    return () => {
      managerRef.current?.destroy();
      managerRef.current = null;
    };
  }, [spec, storage, pubkey, relayUrl]);

  React.useEffect(() => {
    if (!pubkey) {
      return;
    }
    const key = storage.storageKey(pubkey);
    const handler = (e: StorageEvent) => {
      if (e.key !== key) {
        return;
      }
      setStore(storage.readStore(pubkey));
    };
    window.addEventListener("storage", handler);
    return () => {
      window.removeEventListener("storage", handler);
    };
  }, [storage, pubkey]);

  const applyRemote = React.useCallback(
    (
      remote: RemoteChannelFlags<F>,
    ): ((prev: ChannelFlagStore<F>) => ChannelFlagStore<F>) => {
      return (prev) => {
        if (!pubkey) return prev;
        if (remote.createdAt < lastAppliedRemoteTs.current) return prev;
        if (
          remote.createdAt === lastAppliedRemoteTs.current &&
          remote.eventId <= lastAppliedEventId.current
        )
          return prev;
        lastAppliedRemoteTs.current = remote.createdAt;
        lastAppliedEventId.current = remote.eventId;
        managerRef.current?.cancelPendingPublish();
        const merged = storage.mergeStores(prev, remote.store);
        if (!storage.writeStore(pubkey, merged)) return prev;
        return merged;
      };
    },
    [storage, pubkey],
  );

  React.useEffect(() => {
    if (!pubkey || !relayUrl) return;
    let cancelled = false;
    const local = storage.readStore(pubkey);
    void managerRef.current?.bootstrap(local).then((result) => {
      if (cancelled) return;
      if (result.action === "apply-remote") {
        setStore(applyRemote(result.data));
      }
      // "hold": seed already performed by bootstrap (if first-sync), or blocked.
    });
    return () => {
      cancelled = true;
    };
  }, [storage, pubkey, relayUrl, applyRemote]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: relayUrl is intentional — rebinds subscription when the active relay changes even though it is not used inside the effect body directly (the manager via managerRef.current carries it)
  React.useEffect(() => {
    if (!pubkey) return;
    let unsub: (() => Promise<void>) | null = null;
    let cancelled = false;
    void managerRef.current
      ?.subscribe((remote) => {
        if (cancelled) return;
        setStore(applyRemote(remote));
      })
      .then((dispose) => {
        if (cancelled) {
          void dispose();
        } else {
          unsub = dispose;
        }
      });
    return () => {
      cancelled = true;
      if (unsub) void unsub();
    };
  }, [pubkey, relayUrl, applyRemote]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: relayUrl is intentional — rebinds reconnect listener when the active relay changes (community switch) even though it is not referenced directly inside the effect body
  React.useEffect(() => {
    if (!pubkey) return;
    let cancelled = false;
    const unsub = relayClient.subscribeToReconnects(() => {
      void managerRef.current?.fetchRemote().then((result) => {
        if (cancelled) return;
        if (result.status === "found") {
          setStore(applyRemote(result.data));
        }
        const pending = managerRef.current?.getPendingStore();
        if (pending) {
          managerRef.current?.publish(pending);
        }
      });
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [pubkey, relayUrl, applyRemote]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: store.channels is the relevant dep — the outer store identity can change without channels changing (e.g., on reconnect writes)
  const flaggedChannelIds = React.useMemo(
    () => storage.flaggedChannelIds(store),
    [storage, store.channels],
  );

  const setFlag = React.useCallback(
    (channelId: string, value: boolean) => {
      if (!pubkey) return;
      const entry = {
        [storage.field]: value,
        updatedAt: Math.floor(Date.now() / 1000),
      } as ChannelFlagEntry<F>;
      setStore((prev) => {
        const next = storage.boundStore(
          {
            version: 1,
            channels: { ...prev.channels, [channelId]: entry },
          },
          channelId,
        );
        if (!storage.writeStore(pubkey, next)) return prev;
        managerRef.current?.publish(next);
        return next;
      });
    },
    [storage, pubkey],
  );

  return { flaggedChannelIds, setFlag };
}
