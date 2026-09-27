import * as React from "react";

import {
  readReadingPosition,
  writeReadingPosition,
  type ReadingPosition,
} from "@/features/messages/lib/readingPositionStore";

// Commits an initial resume may wait for its row to mount before giving up.
const RESUME_RETRY_LIMIT = 10;
// Older pages a lost reading position may load while being restored.
const RESTORE_OLDER_PAGE_LIMIT = 10;

type AnchorState =
  | { kind: "at-bottom" }
  | { kind: "message"; messageId: string; topOffset: number }
  | { kind: "pinned-center"; messageId: string; contentTop: number };

type ScrollToMessage = (
  messageId: string,
  options?: { highlight?: boolean; behavior?: ScrollBehavior },
) => boolean;

type UseReadingPositionOptions = {
  channelId?: string | null;
  messages: Array<{ id: string }>;
  virtualizerRenderVersion: number;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  /** The scroll hook's anchor and bottom state, shared with this hook. */
  anchorRef: React.MutableRefObject<AnchorState>;
  virtualizerAtBottomRef: React.MutableRefObject<boolean>;
  setIsAtBottom: (atBottom: boolean) => void;
  setNewMessageCount: (count: number) => void;
  isAtBottomNow: (container: HTMLDivElement) => boolean;
  scrollToMessageImperative: ScrollToMessage;
  virtualizerOwnsPrependAnchoring: boolean;
  virtualCancelBottomIntent?: () => void;
  virtualScrollToMessage?: (
    messageId: string,
    options?: { behavior?: ScrollBehavior },
  ) => boolean;
  virtualReadingPosition?: () => ReadingPosition | null;
  requestOlder?: () => "requested" | "busy" | "exhausted";
};

/**
 * Keeps a reader's place in a channel: where a channel opens (the position
 * they left it at, else the oldest unread post), and holding that place when
 * a head refresh (subscribe / relay reconnect) replaces the loaded window.
 *
 * While a resume or restore owns the viewport, a grace period ignores stale
 * floor reports from the list's open-time pin; reader input ends it.
 */
export function useReadingPosition({
  channelId,
  messages,
  virtualizerRenderVersion,
  scrollContainerRef,
  anchorRef,
  virtualizerAtBottomRef,
  setIsAtBottom,
  setNewMessageCount,
  isAtBottomNow,
  scrollToMessageImperative,
  virtualizerOwnsPrependAnchoring,
  virtualCancelBottomIntent,
  virtualScrollToMessage,
  virtualReadingPosition,
  requestOlder,
}: UseReadingPositionOptions) {
  // The message a mid-history reader is on (updated as they scroll; null at
  // the floor).
  const readingRef = React.useRef<ReadingPosition | null>(null);
  // A reading position a head refresh (or a remembered position) points at
  // but that is not loaded: restored by loading older pages.
  const lostReadingRef = React.useRef<{
    messageId: string;
    attemptsLeft: number;
    // The message list a page was last requested for; one request per list.
    requestedFor: readonly { id: string }[] | null;
  } | null>(null);
  // An initial resume target whose row was not mounted on the first pass.
  const pendingResumeRef = React.useRef<{
    messageId: string;
    attemptsLeft: number;
  } | null>(null);
  const graceRef = React.useRef(false);
  const detachGraceRef = React.useRef<(() => void) | null>(null);
  const landingRafRef = React.useRef<number | null>(null);
  const channelIdRef = React.useRef(channelId);

  const endGrace = React.useCallback(() => {
    graceRef.current = false;
    detachGraceRef.current?.();
    detachGraceRef.current = null;
  }, []);

  // A resume that ends at the physical floor (the posts below it already fit
  // on screen) is not a reading position: follow the floor like any bottom
  // view.
  const followFloorIfThere = React.useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container || anchorRef.current.kind !== "message") return;
    if (!isAtBottomNow(container)) return;
    endGrace();
    anchorRef.current = { kind: "at-bottom" };
    virtualizerAtBottomRef.current = true;
    setIsAtBottom(true);
    setNewMessageCount(0);
  }, [
    anchorRef,
    endGrace,
    isAtBottomNow,
    scrollContainerRef,
    setIsAtBottom,
    setNewMessageCount,
    virtualizerAtBottomRef,
  ]);

  // The reader taking over (wheel, touch, pointer, keys) ends the grace; if
  // that leaves them at the floor, the view follows it again.
  const beginGrace = React.useCallback(
    (container: HTMLElement) => {
      endGrace();
      graceRef.current = true;
      const onInput = () => {
        if (!graceRef.current) return;
        endGrace();
        followFloorIfThere();
      };
      const events = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
      for (const type of events) {
        container.addEventListener(type, onInput, { passive: true });
      }
      detachGraceRef.current = () => {
        for (const type of events) {
          container.removeEventListener(type, onInput);
        }
      };
    },
    [endGrace, followFloorIfThere],
  );

  /** The reader's current place: the tracked row, else a message anchor. */
  const currentPosition = React.useCallback((): ReadingPosition | null => {
    if (readingRef.current) return readingRef.current;
    const anchor = anchorRef.current;
    return anchor.kind === "message"
      ? { messageId: anchor.messageId, topOffset: anchor.topOffset }
      : null;
  }, [anchorRef]);

  // At the floor the position is null (no reading row, bottom anchor), which
  // forgets the channel: it then opens at its first unread post or the end.
  const save = React.useCallback(
    (forChannelId: string | null | undefined) => {
      if (forChannelId) writeReadingPosition(forChannelId, currentPosition());
    },
    [currentPosition],
  );

  /** On channel change: remember where the reader left the previous one. */
  const reset = React.useCallback(() => {
    save(channelIdRef.current);
    channelIdRef.current = channelId;
    readingRef.current = null;
    lostReadingRef.current = null;
    pendingResumeRef.current = null;
    if (landingRafRef.current !== null) {
      cancelAnimationFrame(landingRafRef.current);
      landingRafRef.current = null;
    }
    endGrace();
  }, [channelId, endGrace, save]);

  /** The position the reader left this channel at, if remembered. */
  const rememberedPosition = React.useCallback(
    () => (channelId ? readReadingPosition(channelId) : null),
    [channelId],
  );

  const ownViewport = React.useCallback(
    (container: HTMLDivElement, position: ReadingPosition) => {
      virtualCancelBottomIntent?.();
      virtualizerAtBottomRef.current = false;
      beginGrace(container);
      anchorRef.current = { kind: "message", ...position };
      setIsAtBottom(false);
    },
    [
      anchorRef,
      beginGrace,
      setIsAtBottom,
      virtualCancelBottomIntent,
      virtualizerAtBottomRef,
    ],
  );

  /**
   * First positioning of a channel at `position` instead of the floor. The
   * row is scrolled to through Virtua's queue (the list's own open-time floor
   * request is still queued, and a direct DOM scroll would be overwritten a
   * frame later); once it lands, it is put back at its remembered offset and
   * the view follows the floor if it ended there. A row that is not loaded is
   * restored by loading older pages.
   */
  const resumeAt = React.useCallback(
    (container: HTMLDivElement, position: ReadingPosition) => {
      ownViewport(container, position);
      if (!messages.some((message) => message.id === position.messageId)) {
        lostReadingRef.current = {
          messageId: position.messageId,
          attemptsLeft: RESTORE_OLDER_PAGE_LIMIT,
          requestedFor: null,
        };
        return;
      }
      landingRafRef.current = requestAnimationFrame(() => {
        landingRafRef.current = requestAnimationFrame(() => {
          landingRafRef.current = null;
          if (!graceRef.current) return;
          const row = container.querySelector<HTMLElement>(
            `[data-message-id="${CSS.escape(position.messageId)}"]`,
          );
          if (row && position.topOffset !== 0) {
            const drift =
              row.getBoundingClientRect().top -
              container.getBoundingClientRect().top -
              position.topOffset;
            if (Math.abs(drift) > 0.5) container.scrollBy(0, drift);
          }
          followFloorIfThere();
        });
      });
      const resumed =
        virtualizerOwnsPrependAnchoring && virtualScrollToMessage
          ? virtualScrollToMessage(position.messageId, { behavior: "auto" })
          : scrollToMessageImperative(position.messageId, { highlight: false });
      if (!resumed) {
        // Not mounted yet (only rows near the floor render on open): retry as
        // rows commit, like a deep-link target, but bounded.
        pendingResumeRef.current = {
          messageId: position.messageId,
          attemptsLeft: RESUME_RETRY_LIMIT,
        };
      }
    },
    [
      followFloorIfThere,
      messages,
      ownViewport,
      scrollToMessageImperative,
      virtualScrollToMessage,
      virtualizerOwnsPrependAnchoring,
    ],
  );

  /**
   * A committed (non-initial) message change. A head refresh replaces the
   * loaded window with the newest page: if that dropped the reading row, hold
   * the viewport and restore it by loading older pages (returns true: the
   * commit is handled); if it only trimmed rows above a surviving reading row,
   * put that row back at its offset (Virtua keeps the scroll offset, so the
   * view would slide by the removed height).
   */
  const handleCommit = React.useCallback(
    ({
      container,
      prevMessages,
      isPrepend,
      headChanged,
    }: {
      container: HTMLDivElement;
      prevMessages: Array<{ id: string }>;
      isPrepend: boolean;
      headChanged: boolean;
    }): boolean => {
      const reading = currentPosition();
      if (!reading || messages === prevMessages || isPrepend) return false;
      const present = messages.some(
        (message) => message.id === reading.messageId,
      );
      if (
        !present &&
        !lostReadingRef.current &&
        prevMessages.some((message) => message.id === reading.messageId)
      ) {
        lostReadingRef.current = {
          messageId: reading.messageId,
          attemptsLeft: RESTORE_OLDER_PAGE_LIMIT,
          requestedFor: null,
        };
        ownViewport(container, reading);
        return true;
      }
      if (
        present &&
        headChanged &&
        virtualizerOwnsPrependAnchoring &&
        !virtualizerAtBottomRef.current
      ) {
        const row = container.querySelector<HTMLElement>(
          `[data-message-id="${CSS.escape(reading.messageId)}"]`,
        );
        if (row) {
          const drift =
            row.getBoundingClientRect().top -
            container.getBoundingClientRect().top -
            reading.topOffset;
          if (Math.abs(drift) > 0.5) container.scrollBy(0, drift);
        } else {
          virtualScrollToMessage?.(reading.messageId, { behavior: "auto" });
        }
      }
      return false;
    },
    [
      currentPosition,
      messages,
      ownViewport,
      virtualScrollToMessage,
      virtualizerAtBottomRef,
      virtualizerOwnsPrependAnchoring,
    ],
  );

  /**
   * A virtualized at-bottom report. Returns true when it must be ignored (a
   * stale floor report during the grace); otherwise records the reading row.
   */
  const onAtBottomReport = React.useCallback(
    (atBottom: boolean): boolean => {
      if (graceRef.current) {
        if (atBottom) return true;
        if (!lostReadingRef.current) endGrace();
      }
      if (atBottom) {
        readingRef.current = null;
        return false;
      }
      const position = virtualReadingPosition?.();
      if (!position) return false;
      const container = scrollContainerRef.current;
      const row = container?.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(position.messageId)}"]`,
      );
      readingRef.current = {
        messageId: position.messageId,
        // Measure the one reading row so later corrections compare like with
        // like (Virtua offsets exclude list padding).
        topOffset:
          row && container
            ? row.getBoundingClientRect().top -
              container.getBoundingClientRect().top
            : position.topOffset,
      };
      return false;
    },
    [endGrace, scrollContainerRef, virtualReadingPosition],
  );

  /** Non-virtualized scrolls report their computed anchor directly. */
  const recordAnchor = React.useCallback((anchor: AnchorState) => {
    readingRef.current =
      anchor.kind === "message"
        ? { messageId: anchor.messageId, topOffset: anchor.topOffset }
        : null;
  }, []);

  // Finish an initial resume whose row was not mounted on the first pass.
  // Retries on each message or virtualized-range commit, a bounded number of
  // times, and stops as soon as the reader has taken over (anchor changed).
  // biome-ignore lint/correctness/useExhaustiveDependencies: `messages` and `virtualizerRenderVersion` are retry triggers; the effect reads the DOM.
  React.useEffect(() => {
    const pending = pendingResumeRef.current;
    if (!pending) return;
    void virtualizerRenderVersion;
    const anchor = anchorRef.current;
    if (anchor.kind !== "message" || anchor.messageId !== pending.messageId) {
      pendingResumeRef.current = null;
      return;
    }
    if (scrollToMessageImperative(pending.messageId, { highlight: false })) {
      pendingResumeRef.current = null;
      return;
    }
    pending.attemptsLeft -= 1;
    if (pending.attemptsLeft <= 0) pendingResumeRef.current = null;
  }, [
    anchorRef,
    messages,
    scrollToMessageImperative,
    virtualizerRenderVersion,
  ]);

  // Restore a reading position that is not loaded: load older pages (a
  // bounded number) until its row is back, then return the reader to it. The
  // reader taking over, or history running out, ends the attempt.
  React.useEffect(() => {
    const lost = lostReadingRef.current;
    if (!lost) return;
    if (!graceRef.current) {
      lostReadingRef.current = null;
      return;
    }
    if (messages.some((message) => message.id === lost.messageId)) {
      lostReadingRef.current = null;
      if (virtualizerOwnsPrependAnchoring && virtualScrollToMessage) {
        virtualScrollToMessage(lost.messageId, { behavior: "auto" });
      } else {
        scrollToMessageImperative(lost.messageId, { highlight: false });
      }
      return;
    }
    // One page per committed list: a re-run with the same messages (a callback
    // identity change) must not stack another fetch behind the one in flight.
    if (lost.requestedFor === messages) return;
    const result =
      lost.attemptsLeft > 0 ? (requestOlder?.() ?? "exhausted") : "exhausted";
    if (result === "requested") {
      lost.attemptsLeft -= 1;
      lost.requestedFor = messages;
    } else if (result === "exhausted") {
      lostReadingRef.current = null;
      endGrace();
    }
  }, [
    endGrace,
    messages,
    requestOlder,
    scrollToMessageImperative,
    virtualScrollToMessage,
    virtualizerOwnsPrependAnchoring,
  ]);

  // Remember the position when the app is hidden, minimized or closed (a
  // channel switch and unmount are covered by `reset` and the cleanup below).
  React.useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") save(channelIdRef.current);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [save]);

  React.useEffect(
    () => () => {
      save(channelIdRef.current);
      detachGraceRef.current?.();
      detachGraceRef.current = null;
      if (landingRafRef.current !== null) {
        cancelAnimationFrame(landingRafRef.current);
      }
    },
    [save],
  );

  return React.useMemo(
    () => ({
      reset,
      rememberedPosition,
      resumeAt,
      handleCommit,
      onAtBottomReport,
      recordAnchor,
    }),
    [
      handleCommit,
      onAtBottomReport,
      recordAnchor,
      rememberedPosition,
      reset,
      resumeAt,
    ],
  );
}
