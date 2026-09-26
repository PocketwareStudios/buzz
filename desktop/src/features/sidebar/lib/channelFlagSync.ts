import { relayClient } from "@/shared/api/relayClient";
import {
  nip44DecryptFromSelf,
  nip44EncryptToSelf,
  signRelayEvent,
} from "@/shared/api/tauri";
import type { RelayEvent } from "@/shared/api/types";
import type {
  ChannelFlagStorage,
  ChannelFlagStore,
} from "./channelFlagStorage";
import {
  advanceWatermark,
  readWatermark,
  runBootstrap,
  type FetchResult,
} from "./sidebarSyncWatermark";

const DEBOUNCE_MS = 2_000;

/** How one flag is carried on the relay: an encrypted, self-addressed blob. */
export type ChannelFlagSyncSpec<F extends string> = {
  storage: ChannelFlagStorage<F>;
  /** Addressable event kind (NIP-78 app data). */
  kind: number;
  /** `d` tag of the blob; also its watermark blob type. Part of the wire format. */
  dTag: string;
  /** Plural noun for publish errors, e.g. "channel mutes". */
  noun: string;
  /** Prefix for console warnings, e.g. "channelMutesSync". */
  logName: string;
};

export type RemoteChannelFlags<F extends string> = {
  store: ChannelFlagStore<F>;
  createdAt: number;
  eventId: string;
};

export class ChannelFlagSyncManager<F extends string> {
  private spec: ChannelFlagSyncSpec<F>;
  private pubkey: string;
  private relayUrl: string;
  private debounceTimer: number | null = null;
  private lastRemoteCreatedAt: number;
  private pendingStore: ChannelFlagStore<F> | null = null;
  private lastPublishedStore: ChannelFlagStore<F> | null = null;
  private destroyed = false;

  constructor(spec: ChannelFlagSyncSpec<F>, pubkey: string, relayUrl: string) {
    this.spec = spec;
    this.pubkey = pubkey;
    this.relayUrl = relayUrl;
    this.lastRemoteCreatedAt = readWatermark(pubkey, spec.dTag, relayUrl);
  }

  private async decryptAndParse(
    event: RelayEvent,
  ): Promise<RemoteChannelFlags<F> | null> {
    try {
      const plaintext = await nip44DecryptFromSelf(event.content);
      const store = this.spec.storage.parsePayload(JSON.parse(plaintext));
      if (!store) return null;
      return { store, createdAt: event.created_at, eventId: event.id };
    } catch {
      return null;
    }
  }

  private ownBlobFilter(limit: number) {
    return {
      kinds: [this.spec.kind],
      authors: [this.pubkey],
      "#d": [this.spec.dTag],
      limit,
    };
  }

  async fetchRemote(): Promise<FetchResult<RemoteChannelFlags<F>>> {
    try {
      const events = await relayClient.fetchEvents(this.ownBlobFilter(1));
      if (events.length === 0 || events[0].pubkey !== this.pubkey) {
        return { status: "absent" };
      }
      const event = events[0];
      this.recordRemoteHead(event.created_at);
      const result = await this.decryptAndParse(event);
      if (!result) {
        return { status: "failed", createdAt: event.created_at };
      }
      return {
        status: "found",
        data: result,
        createdAt: result.createdAt,
        eventId: result.eventId,
      };
    } catch {
      return { status: "failed" };
    }
  }

  private recordRemoteHead(createdAt: number): void {
    if (createdAt > this.lastRemoteCreatedAt) {
      this.lastRemoteCreatedAt = createdAt;
    }
    advanceWatermark(this.pubkey, this.spec.dTag, this.relayUrl, createdAt);
  }

  cancelPendingPublish(): void {
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  getPendingStore(): ChannelFlagStore<F> | null {
    return this.pendingStore;
  }

  publish(store: ChannelFlagStore<F>): void {
    this.pendingStore = store;
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      void this.doPublish(store);
    }, DEBOUNCE_MS);
  }

  private async fetchOwnBlobBeforePublish(
    store: ChannelFlagStore<F>,
  ): Promise<ChannelFlagStore<F>> {
    try {
      const events = await relayClient.fetchEvents(this.ownBlobFilter(1));
      if (events.length === 0 || events[0].pubkey !== this.pubkey) return store;
      const event = events[0];
      // Record the raw head before decrypt on the pre-publish path too.
      this.recordRemoteHead(event.created_at);
      const remote = await this.decryptAndParse(event);
      if (!remote) return store;
      return this.spec.storage.mergeStores(store, remote.store);
    } catch {
      return store;
    }
  }

  private isIdenticalToLastPublished(store: ChannelFlagStore<F>): boolean {
    if (!this.lastPublishedStore) return false;
    const field = this.spec.storage.field;
    const lastKeys = Object.keys(this.lastPublishedStore.channels);
    const currentKeys = Object.keys(store.channels);
    if (lastKeys.length !== currentKeys.length) return false;
    for (const key of currentKeys) {
      const last = this.lastPublishedStore.channels[key];
      const current = store.channels[key];
      if (
        !last ||
        last[field] !== current[field] ||
        last.updatedAt !== current.updatedAt
      )
        return false;
    }
    return true;
  }

  private async doPublish(store: ChannelFlagStore<F>): Promise<void> {
    try {
      const merged = await this.fetchOwnBlobBeforePublish(store);
      // Guard: manager may have been destroyed while fetchOwnBlobBeforePublish
      // was awaited (community switch during in-flight fetch). If so, abort
      // before touching the relay.
      if (this.destroyed) return;
      if (this.isIdenticalToLastPublished(merged)) {
        this.pendingStore = null;
        return;
      }
      const payload = {
        version: 1,
        channels: merged.channels,
      };
      const ciphertext = await nip44EncryptToSelf(JSON.stringify(payload));
      const createdAt = Math.max(
        Math.floor(Date.now() / 1_000),
        this.lastRemoteCreatedAt + 1,
      );
      const event = await signRelayEvent({
        kind: this.spec.kind,
        content: ciphertext,
        createdAt,
        tags: [
          ["d", this.spec.dTag],
          ["t", this.spec.dTag], // relay discoverability; not used in our filters
        ],
      });
      if (this.destroyed) return;
      await relayClient.publishEvent(
        event,
        `Timed out publishing ${this.spec.noun}.`,
        `Failed to publish ${this.spec.noun}.`,
      );
      this.recordRemoteHead(event.created_at);
      this.lastPublishedStore = merged;
      this.pendingStore = null;
    } catch (error) {
      console.warn(`[${this.spec.logName}] publish failed:`, error);
    }
  }

  async subscribe(
    onUpdate: (remote: RemoteChannelFlags<F>) => void,
  ): Promise<() => Promise<void>> {
    return relayClient.subscribeLive(
      this.ownBlobFilter(0),
      (event: RelayEvent) => {
        if (event.pubkey !== this.pubkey) return;
        // Record the raw head before decrypt so an undecryptable live event
        // still advances the watermark and blocks future seed-publish.
        this.recordRemoteHead(event.created_at);
        void this.decryptAndParse(event).then((result) => {
          if (result) {
            onUpdate(result);
          }
        });
      },
    );
  }

  /**
   * Fetches the remote blob on first mount, records the remote head, and
   * delegates the seed/hold/apply-remote decision to `runBootstrap`.
   */
  async bootstrap(localStore: ChannelFlagStore<F>) {
    const fetchResult = await this.fetchRemote();
    return runBootstrap({
      fetchResult,
      lastHead: this.lastRemoteCreatedAt,
      localStore,
      isLocalNonEmpty: (s) => Object.keys(s.channels).length > 0,
      publishFn: (s) => this.publish(s),
    });
  }

  destroy(): void {
    // Cancel any pending publish and mark this manager as destroyed so any
    // in-flight doPublish() calls abort before reaching relayClient.
    // Pending debounce-window changes are intentionally dropped: flushing
    // could publish relay A's state to relay B via the shared relayClient
    // singleton. Local entries survive because the apply/publish paths merge
    // per-entry via mergeStores, so no local work is permanently lost.
    this.destroyed = true;
    this.cancelPendingPublish();
    this.pendingStore = null;
  }
}
