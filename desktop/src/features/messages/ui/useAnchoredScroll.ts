import * as React from "react";

import { classifyTimelineMessageDelta } from "@/features/messages/lib/timelineSnapshot";
import {
  getPinnedCenterDrift,
  settleProgrammaticBottomPin,
  shouldIgnorePinnedCenterScroll,
  shouldSettleForSplitPanel,
  shouldSettleVirtualizedBottom,
} from "./anchoredScrollPolicy";
import { useVirtualizedViewportResize } from "./useVirtualizedViewportResize";

/**
 * Distance (in CSS pixels) below which we consider the scroll position
 * "at the bottom" of the message list. Tight enough that the user has to
 * actually scroll down to re-pin; permissive enough to tolerate sub-pixel
 * rounding from the layout engine.
 */
const AT_BOTTOM_THRESHOLD_PX = 32;
// Commits an initial resume may wait for its row to mount before giving up.
const RESUME_RETRY_LIMIT = 10;
// Older pages a lost reading position may load while being restored.
const RESTORE_OLDER_PAGE_LIMIT = 10;

type AnchorState =
  | { kind: "at-bottom" }
  | { kind: "message"; messageId: string; topOffset: number }
  | { kind: "pinned-center"; messageId: string; contentTop: number };

type UseAnchoredScrollOptions = {
  /** Scroll container. Owned by the parent so external refs still compose. */
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  /** Inner content element — must wrap every renderable row, including the
   *  sentinel and bottom anchor. Used to schedule layout work on resize. */
  contentRef: React.RefObject<HTMLDivElement | null>;
  /** Resets when changed; lets us drop anchor + scroll state across channels. */
  channelId?: string | null;
  /** Suppresses initial scroll-to-bottom while a skeleton is showing. */
  isLoading: boolean;
  /** Source of truth for the rendered list. Used to detect new-at-bottom
   *  arrivals and to seed/refresh the anchor pre-render. */
  messages: Array<{ id: string }>;
  splitPanelOpen?: boolean;

  /** Where a freshly mounted or switched channel starts when there is no
   *  `targetMessageId`: typically the oldest unread post. Used once per
   *  channel, without a highlight; null starts at the bottom. */
  initialMessageId?: string | null;
  /** Virtualizer read of the message at the top of the viewport (cheap, no
   *  DOM walk), used to remember where a mid-history reader is. */
  virtualReadingPosition?: () => {
    messageId: string;
    topOffset: number;
  } | null;
  /** Asks for one older page while restoring a reading position that a head
   *  refresh dropped: "requested", "busy" (retry when messages change) or
   *  "exhausted" (no older history to load). */
  requestOlder?: () => "requested" | "busy" | "exhausted";
  /** When set, scroll to this message on mount and on change. */
  targetMessageId?: string | null;
  /** Whether a targeted message should pulse after scrolling to it. */
  highlightTargetMessage?: boolean;
  /** Keeps a targeted message centered until the user deliberately scrolls. */
  pinTargetCentered?: boolean;
  onTargetReached?: (messageId: string) => void;
  /** Reports a pinned target after resize correction and one paint frame. */
  onTargetSettled?: (messageId: string) => void;
  virtualCancelBottomIntent?: () => void;
  virtualScrollToMessage?: (
    messageId: string,
    options?: { behavior?: ScrollBehavior },
  ) => boolean;
  /** Imperative virtualizer-owned bottom jump, used only when virtualizer mode is active. */
  virtualScrollToBottom?: (behavior?: ScrollBehavior) => void;
  virtualSettleAtBottom?: () => void;
  /** When active, the virtualizer owns prepend compensation and bottom-state synchronization. */
  virtualizerOwnsPrependAnchoring?: boolean;
  /** Bumps when a virtualized range changes, so pending target/search retries can re-check newly mounted DOM. */
  virtualizerRenderVersion?: number;
};

type UseAnchoredScrollResult = {
  /** Pass through to the scroll container's `onScroll`. */
  onScroll: () => void;
  /** True when the user is within `AT_BOTTOM_THRESHOLD_PX` of the bottom. */
  isAtBottom: boolean;
  /** Number of new messages that have arrived while the user is not at the
   *  bottom. Cleared when the user returns to the bottom. */
  newMessageCount: number;
  /** Message id that should pulse a highlight (target/active-search). */
  highlightedMessageId: string | null;
  /** Imperative: scroll to bottom. */
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  /** Re-pins after a layout owner changes trailing geometry. Returns true when
   *  the hook handled the settlement, including a preserved pinned target. */
  settleAtBottomAfterLayout: () => boolean;
  /** Arm a one-shot: the next appended messages join below the reader instead
   *  of pulling the view to the new floor. Used when output that was held
   *  back while the reader was scrolled up is released at the old floor, so
   *  the reader continues from the first new post. */
  holdPositionOnNextAppend: () => void;
  /** Whether the view is following the floor (not anchored to a message the
   *  reader is on). External layout owners use it to avoid pulling a reader
   *  who is mid-history down to the bottom. */
  isFollowingBottom: () => boolean;
  /** Arm a one-shot scroll-to-bottom that fires on the next appended message
   *  (used by the composer's send flow). */
  scrollToBottomOnNextUpdate: () => void;
  /** Imperative: scroll a specific message into view; optionally pulse it.
   *  Returns true if the row was found and scrolled, false otherwise. */
  scrollToMessage: (
    messageId: string,
    options?: { highlight?: boolean; behavior?: ScrollBehavior },
  ) => boolean;
  /** Syncs the hook's bottom affordances from a virtualizer-owned scroller. */
  onVirtualizerAtBottomStateChange: (atBottom: boolean) => void;
};

function isAtBottomNow(
  container: Pick<
    HTMLDivElement,
    "scrollHeight" | "clientHeight" | "scrollTop"
  >,
) {
  return (
    container.scrollHeight - container.clientHeight - container.scrollTop <=
    AT_BOTTOM_THRESHOLD_PX
  );
}

/**
 * Pick an anchor for the current scroll position.
 *
 * Top-crossing walk: chronological children, top-down. The first
 * `data-message-id` row whose bottom edge has crossed below the container
 * top is the anchor — that's the row the reader's eye is on when they've
 * scrolled up through history. `topOffset` is the row's top relative to
 * the container's top and may be negative when the row straddles the edge.
 *
 * If no such row exists (e.g. nothing scrolled past the top, list shorter
 * than the viewport, etc.) the anchor is `at-bottom`.
 *
 * Algorithm credit: Sami's [13] in the buzz-bugs scroll-redesign thread,
 * supersedes the Matrix-style bottom-up walk in [7]. The top-crossing
 * choice is what keeps the row the reader is *reading* fixed under
 * in-viewport reflow (image-load, embed expansion).
 */
function computeAnchor(
  container: HTMLDivElement,
  treatNearBottomAsBottom = true,
): AnchorState {
  if (treatNearBottomAsBottom && isAtBottomNow(container)) {
    return { kind: "at-bottom" };
  }

  const containerTop = container.getBoundingClientRect().top;
  const rows = container.querySelectorAll<HTMLElement>("[data-message-id]");

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rect = row.getBoundingClientRect();
    if (rect.bottom > containerTop) {
      const messageId = row.dataset.messageId;
      if (messageId) {
        return {
          kind: "message",
          messageId,
          topOffset: rect.top - containerTop,
        };
      }
    }
  }

  return { kind: "at-bottom" };
}

export function useAnchoredScroll({
  scrollContainerRef,
  contentRef,
  channelId,
  isLoading,
  messages,
  splitPanelOpen = false,

  targetMessageId = null,
  highlightTargetMessage = true,
  pinTargetCentered = false,
  onTargetReached,
  onTargetSettled,
  virtualCancelBottomIntent,
  virtualScrollToMessage,
  virtualScrollToBottom,
  virtualSettleAtBottom,
  virtualizerOwnsPrependAnchoring = false,
  virtualizerRenderVersion = 0,
  initialMessageId = null,
  virtualReadingPosition,
  requestOlder,
}: UseAnchoredScrollOptions): UseAnchoredScrollResult {
  // Anchor lives in a ref because it must survive renders and is updated
  // both on scroll (commit-time read) and in the layout effect (post-render
  // restoration). useState would force re-renders we don't want.
  const anchorRef = React.useRef<AnchorState>({ kind: "at-bottom" });
  const virtualizerAtBottomRef = React.useRef(true);
  const [isAtBottom, setIsAtBottom] = React.useState(true);
  React.useLayoutEffect(() => {
    if (shouldSettleForSplitPanel({ isAtBottom, splitPanelOpen })) {
      virtualSettleAtBottom?.();
    }
  }, [isAtBottom, splitPanelOpen, virtualSettleAtBottom]);
  const [newMessageCount, setNewMessageCount] = React.useState(0);
  const [highlightedMessageId, setHighlightedMessageId] = React.useState<
    string | null
  >(null);

  const hasInitializedRef = React.useRef(false);
  const prevLastMessageIdRef = React.useRef<string | undefined>(undefined);
  const prevFirstMessageIdRef = React.useRef<string | undefined>(undefined);
  const prevMessageCountRef = React.useRef(0);
  const prevMessagesRef = React.useRef<Array<{ id: string }>>([]);
  const handledTargetIdRef = React.useRef<string | null>(null);
  const highlightTimeoutRef = React.useRef<number | null>(null);
  // Tracks a pending rAF queued by pinToBottomOnMount so it can be cancelled
  // on channel switch (the channelId reset effect clears it).
  const mountPinRafIdRef = React.useRef<number | null>(null);
  // One-shot: the consumer calls `scrollToBottomOnNextUpdate()` right before
  // it sends a message (see ChannelPane). When the user's own message then
  // appends, we snap to bottom even if they had scrolled up to read history.
  // Consumed (and cleared) by the next append in the restoration effect.
  const forceBottomOnNextAppendRef = React.useRef(false);
  // One-shot, the opposite of the above: released held-back output appends
  // below the reading position without re-pinning to the floor. Consumed (and
  // cleared) by the next message commit, whatever it contains.
  const holdPositionOnNextAppendRef = React.useRef(false);
  // The message a mid-history reader is on (updated as they scroll; null at
  // the floor), and a reading position a head refresh dropped that is being
  // restored by loading older pages.
  const readingRef = React.useRef<{
    messageId: string;
    topOffset: number;
  } | null>(null);
  const lostReadingRef = React.useRef<{
    messageId: string;
    attemptsLeft: number;
    // The message list a page was last requested for; one request per list.
    requestedFor: readonly { id: string }[] | null;
  } | null>(null);
  // True from an initial resume until the view has left the floor or the
  // reader interacts; see `onVirtualizerAtBottomStateChange`.
  const resumeGraceRef = React.useRef(false);
  // Detaches the input listeners that end a resume's grace (attached only
  // while a grace is active).
  const detachResumeGraceRef = React.useRef<(() => void) | null>(null);
  // An initial resume target whose row was not mounted on the first pass.
  const pendingResumeRef = React.useRef<{
    messageId: string;
    attemptsLeft: number;
  } | null>(null);
  // True from a programmatic bottom pin until the list's row measurement settles
  // and the view reaches a true physical bottom. During this window `onScroll`
  // ignores transient gaps and keeps chasing the floor. A `ref`, not state — the
  // guard runs on a native scroll event, outside React's render cycle.
  const settlingRef = React.useRef(false);
  // Pinned-center corrections write scroll position themselves. Keep the next
  // matching scroll event from being mistaken for a user releasing the pin.
  const programmaticScrollTopRef = React.useRef<number | null>(null);
  const isWritingScrollRef = React.useRef(false);
  const programmaticScrollRafRef = React.useRef<number | null>(null);
  const targetSettleRafRef = React.useRef<number | null>(null);

  // Reset everything when the channel changes — the layout effect that runs
  // immediately after this reset is responsible for either jumping to bottom
  // or to the target message for the new channel.
  // biome-ignore lint/correctness/useExhaustiveDependencies: channelId is intentionally the sole trigger — we want this effect to fire exactly when the channel changes (and on mount).
  React.useLayoutEffect(() => {
    anchorRef.current = { kind: "at-bottom" };
    virtualizerAtBottomRef.current = true;
    setIsAtBottom(true);
    setNewMessageCount(0);
    setHighlightedMessageId(null);
    hasInitializedRef.current = false;
    prevLastMessageIdRef.current = undefined;
    prevFirstMessageIdRef.current = undefined;
    prevMessageCountRef.current = 0;
    prevMessagesRef.current = [];
    handledTargetIdRef.current = null;
    forceBottomOnNextAppendRef.current = false;
    holdPositionOnNextAppendRef.current = false;
    pendingResumeRef.current = null;
    readingRef.current = null;
    lostReadingRef.current = null;
    resumeGraceRef.current = false;
    detachResumeGraceRef.current?.();
    detachResumeGraceRef.current = null;
    settlingRef.current = false;
    programmaticScrollTopRef.current = null;
    isWritingScrollRef.current = false;
    if (programmaticScrollRafRef.current !== null) {
      cancelAnimationFrame(programmaticScrollRafRef.current);
      programmaticScrollRafRef.current = null;
    }
    if (targetSettleRafRef.current !== null) {
      cancelAnimationFrame(targetSettleRafRef.current);
      targetSettleRafRef.current = null;
    }
    if (highlightTimeoutRef.current !== null) {
      window.clearTimeout(highlightTimeoutRef.current);
      highlightTimeoutRef.current = null;
    }
    if (mountPinRafIdRef.current !== null) {
      cancelAnimationFrame(mountPinRafIdRef.current);
      mountPinRafIdRef.current = null;
    }
  }, [channelId]);

  const noteProgrammaticScroll = React.useCallback(
    (container: HTMLDivElement, scrollTopBefore: number) => {
      if (scrollTopBefore === container.scrollTop) return;

      programmaticScrollTopRef.current = container.scrollTop;
      if (programmaticScrollRafRef.current !== null) {
        cancelAnimationFrame(programmaticScrollRafRef.current);
      }
      // A programmatic scroll event is delivered before the next frame. If the
      // browser does not emit one, expire the guard so a later user scroll is
      // never swallowed.
      programmaticScrollRafRef.current = requestAnimationFrame(() => {
        if (programmaticScrollTopRef.current === container.scrollTop) {
          programmaticScrollTopRef.current = null;
        }
        programmaticScrollRafRef.current = null;
      });
    },
    [],
  );

  const writePinnedCenterScroll = React.useCallback(
    (container: HTMLDivElement, write: () => void) => {
      const scrollTopBefore = container.scrollTop;
      isWritingScrollRef.current = true;
      write();
      isWritingScrollRef.current = false;
      noteProgrammaticScroll(container, scrollTopBefore);
    },
    [noteProgrammaticScroll],
  );

  const repinPinnedCenter = React.useCallback(() => {
    const anchor = anchorRef.current;
    const container = scrollContainerRef.current;
    if (anchor.kind !== "pinned-center" || !container) return;

    const row = container.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(anchor.messageId)}"]`,
    );
    if (!row) return;

    const currentContentTop =
      row.getBoundingClientRect().top +
      container.scrollTop -
      container.getBoundingClientRect().top;
    const drift = getPinnedCenterDrift({
      contentTop: anchor.contentTop,
      currentContentTop,
    });
    if (drift === null) return;

    anchor.contentTop = currentContentTop;
    writePinnedCenterScroll(container, () => container.scrollBy(0, drift));
  }, [scrollContainerRef, writePinnedCenterScroll]);

  const releasePinnedCenter = React.useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container || anchorRef.current.kind !== "pinned-center") return;

    // A selected row can sit near the physical floor after its deliberate
    // center. A direct user scroll there must still release the center pin;
    // otherwise a passive representative update is mistaken for bottom glue.
    anchorRef.current = computeAnchor(container, false);
    const atBottom = isAtBottomNow(container);
    setIsAtBottom((previous) => (previous === atBottom ? previous : atBottom));
    if (atBottom) setNewMessageCount(0);
  }, [scrollContainerRef]);

  const schedulePinnedTargetSettle = React.useCallback(
    (messageId: string) => {
      if (!onTargetSettled) return;
      if (targetSettleRafRef.current !== null) {
        cancelAnimationFrame(targetSettleRafRef.current);
      }
      targetSettleRafRef.current = requestAnimationFrame(() => {
        targetSettleRafRef.current = null;
        const container = scrollContainerRef.current;
        const anchor = anchorRef.current;
        if (
          !container ||
          anchor.kind !== "pinned-center" ||
          anchor.messageId !== messageId
        ) {
          return;
        }
        const row = container.querySelector<HTMLElement>(
          `[data-message-id="${CSS.escape(messageId)}"]`,
        );
        if (!row) return;
        const rowRect = row.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        if (
          rowRect.bottom > containerRect.top &&
          rowRect.top < containerRect.bottom
        ) {
          onTargetSettled(messageId);
        }
      });
    },
    [onTargetSettled, scrollContainerRef],
  );

  const scrollToBottomImperative = React.useCallback(
    (behavior: ScrollBehavior = "auto") => {
      const container = scrollContainerRef.current;
      if (!container) return;
      anchorRef.current = { kind: "at-bottom" };
      // A programmatic jump-to-bottom is not atomic, even for `behavior: "auto"`:
      // the browser can emit `scroll` while the list is still settling row
      // measurements. During that window `computeAnchor` may read the transient
      // gap as a deliberate scroll-up and latch a mid-history message anchor,
      // which strands future appends above the floor. Arm the settle guard for
      // every imperative bottom jump so `onScroll` holds the at-bottom anchor
      // until it can snap to the true floor.
      settlingRef.current = true;
      if (virtualizerOwnsPrependAnchoring && virtualScrollToBottom) {
        virtualScrollToBottom(behavior);
      } else {
        container.scrollTo({ top: container.scrollHeight, behavior });
      }
      setIsAtBottom(true);
      setNewMessageCount(0);
    },
    [
      scrollContainerRef,
      virtualScrollToBottom,
      virtualizerOwnsPrependAnchoring,
    ],
  );

  // Arm a one-shot: the next append snaps to bottom regardless of where the
  // user is. The consumer calls this right before sending so their own
  // outbound message pulls the view down even if they'd scrolled up.
  const scrollToBottomOnNextUpdate = React.useCallback(() => {
    forceBottomOnNextAppendRef.current = true;
  }, []);

  // A resume that ends at the physical floor (the unread posts already fit on
  // screen) is not a reading position: follow the floor like any bottom view.
  const endResumeGrace = React.useCallback(() => {
    resumeGraceRef.current = false;
    detachResumeGraceRef.current?.();
    detachResumeGraceRef.current = null;
  }, []);

  const followFloorIfResumedThere = React.useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container || anchorRef.current.kind !== "message") return;
    if (!isAtBottomNow(container)) return;
    endResumeGrace();
    anchorRef.current = { kind: "at-bottom" };
    virtualizerAtBottomRef.current = true;
    setIsAtBottom(true);
    setNewMessageCount(0);
  }, [endResumeGrace, scrollContainerRef]);

  // The reader taking over (wheel, touch, pointer, keys) ends a resume's
  // grace; if that leaves them at the floor, the view follows it again.
  const beginResumeGrace = React.useCallback(
    (container: HTMLElement) => {
      endResumeGrace();
      resumeGraceRef.current = true;
      const onInput = () => {
        if (!resumeGraceRef.current) return;
        endResumeGrace();
        followFloorIfResumedThere();
      };
      const events = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
      for (const type of events) {
        container.addEventListener(type, onInput, { passive: true });
      }
      detachResumeGraceRef.current = () => {
        for (const type of events) {
          container.removeEventListener(type, onInput);
        }
      };
    },
    [endResumeGrace, followFloorIfResumedThere],
  );

  const holdPositionOnNextAppend = React.useCallback(() => {
    holdPositionOnNextAppendRef.current = true;
  }, []);

  const isFollowingBottom = React.useCallback(
    () => anchorRef.current.kind === "at-bottom",
    [],
  );

  const settleAtBottomAfterLayout = React.useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return false;
    if (anchorRef.current.kind === "pinned-center") {
      repinPinnedCenter();
      const atBottom = isAtBottomNow(container);
      setIsAtBottom((previous) =>
        previous === atBottom ? previous : atBottom,
      );
      if (atBottom) setNewMessageCount(0);
      schedulePinnedTargetSettle(anchorRef.current.messageId);
      return true;
    }
    if (!isAtBottomNow(container)) return false;

    anchorRef.current = { kind: "at-bottom" };
    setIsAtBottom(true);
    setNewMessageCount(0);
    if (!virtualizerOwnsPrependAnchoring) {
      container.scrollTo({ top: container.scrollHeight, behavior: "auto" });
    }
    return true;
  }, [
    repinPinnedCenter,
    schedulePinnedTargetSettle,
    scrollContainerRef,
    virtualizerOwnsPrependAnchoring,
  ]);

  const highlightMessage = React.useCallback((messageId: string) => {
    if (highlightTimeoutRef.current !== null) {
      window.clearTimeout(highlightTimeoutRef.current);
    }
    setHighlightedMessageId(messageId);
    highlightTimeoutRef.current = window.setTimeout(() => {
      setHighlightedMessageId((current) =>
        current === messageId ? null : current,
      );
      highlightTimeoutRef.current = null;
    }, 2_000);
  }, []);

  const scrollToMessageImperative = React.useCallback(
    (
      messageId: string,
      options: { highlight?: boolean; behavior?: ScrollBehavior } = {},
    ): boolean => {
      const container = scrollContainerRef.current;
      if (!container) return false;
      const el = container.querySelector<HTMLElement>(
        `[data-message-id="${messageId}"]`,
      );
      if (virtualizerOwnsPrependAnchoring && virtualScrollToMessage) {
        // Target navigation owns the viewport before any movement strategy is
        // chosen. The already-mounted fast path centers the DOM node directly
        // and would otherwise leave durable bottom intent armed.
        virtualCancelBottomIntent?.();
        if (el) {
          const rect = el.getBoundingClientRect();
          const containerRect = container.getBoundingClientRect();
          const isInViewport =
            rect.top >= containerRect.top &&
            rect.bottom <= containerRect.bottom;
          if (!isInViewport) {
            if (!virtualScrollToMessage(messageId, { behavior: "auto" })) {
              return false;
            }
            anchorRef.current = { kind: "message", messageId, topOffset: 0 };
            setIsAtBottom(false);
            return false;
          }
          const centeredTop = (container.clientHeight - rect.height) / 2;
          container.scrollTo({
            top: Math.max(
              0,
              container.scrollTop +
                (rect.top - containerRect.top) -
                centeredTop,
            ),
            behavior: options.behavior ?? "auto",
          });
        } else if (
          !virtualScrollToMessage(messageId, {
            behavior: options.behavior ?? "auto",
          })
        ) {
          return false;
        }
        anchorRef.current = { kind: "message", messageId, topOffset: 0 };
        setIsAtBottom(false);
        if (el && options.highlight) highlightMessage(messageId);
        return el !== null;
      }

      if (!el) return false;

      const rect = el.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const currentTopOffset = rect.top - containerRect.top;
      const centeredTopOffset = (container.clientHeight - rect.height) / 2;
      const maxScrollTop = Math.max(
        0,
        container.scrollHeight - container.clientHeight,
      );
      const targetScrollTop = Math.min(
        maxScrollTop,
        Math.max(0, container.scrollTop + currentTopOffset - centeredTopOffset),
      );
      const targetTopOffset =
        currentTopOffset - (targetScrollTop - container.scrollTop);
      const contentTop = rect.top + container.scrollTop - containerRect.top;

      if (pinTargetCentered) {
        writePinnedCenterScroll(container, () => {
          el.scrollIntoView({
            block: "center",
            behavior: options.behavior ?? "auto",
          });
        });
        anchorRef.current = {
          kind: "pinned-center",
          messageId,
          contentTop,
        };
        setIsAtBottom(isAtBottomNow(container));
      } else {
        container.scrollTo({
          top: targetScrollTop,
          behavior: options.behavior ?? "auto",
        });

        // Smooth scrolling starts an async animation, so measuring after the call can still return the pre-animation position.
        // Save the clamped destination offset instead; otherwise a concurrent
        // render/ResizeObserver restore can fight the smooth scroll back toward
        // where it started.
        anchorRef.current = {
          kind: "message",
          messageId,
          topOffset: targetTopOffset,
        };
      }
      if (!pinTargetCentered) {
        setIsAtBottom(maxScrollTop - targetScrollTop <= AT_BOTTOM_THRESHOLD_PX);
      }

      if (options.highlight) highlightMessage(messageId);
      return true;
    },
    [
      highlightMessage,
      pinTargetCentered,
      scrollContainerRef,
      virtualCancelBottomIntent,
      virtualizerOwnsPrependAnchoring,
      writePinnedCenterScroll,
      virtualScrollToMessage,
    ],
  );

  // Scroll handler: recompute anchor + bottom state from the current
  // scroll position. Cheap enough to run on every scroll event — a single
  // `getBoundingClientRect` walk plus rect reads.
  const onScroll = React.useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    // Virtua owns anchoring and reports bottom state separately. Avoid the
    // fallback's O(N) DOM walk on every compositor-driven scroll event.
    if (virtualizerOwnsPrependAnchoring) return;
    // Row measurement can grow `scrollHeight` after a bottom pin and emit scroll
    // events while `scrollTop` holds at the old floor — opening a transient gap
    // above the true bottom. `computeAnchor` would read that as a deliberate
    // scroll-up and latch a message anchor, freezing the view short of bottom.
    // While settling, keep the anchor at-bottom and chase the physical floor.
    if (settlingRef.current) {
      if (settleProgrammaticBottomPin(container)) {
        settlingRef.current = false;
      } else {
        if (virtualizerOwnsPrependAnchoring) {
          settlingRef.current = false;
        }
        return;
      }
    }
    if (anchorRef.current.kind === "pinned-center") {
      if (
        shouldIgnorePinnedCenterScroll({
          currentScrollTop: container.scrollTop,
          expectedScrollTop: programmaticScrollTopRef.current,
          isWritingScroll: isWritingScrollRef.current,
        })
      ) {
        if (programmaticScrollTopRef.current === container.scrollTop) {
          programmaticScrollTopRef.current = null;
        }
        return;
      }
      releasePinnedCenter();
      return;
    }
    anchorRef.current = computeAnchor(container);
    readingRef.current =
      anchorRef.current.kind === "message" ? { ...anchorRef.current } : null;
    const atBottom = anchorRef.current.kind === "at-bottom";
    setIsAtBottom((prev) => (prev === atBottom ? prev : atBottom));
    if (atBottom) {
      setNewMessageCount(0);
    }
  }, [
    releasePinnedCenter,
    scrollContainerRef,
    virtualizerOwnsPrependAnchoring,
  ]);

  // ---------------------------------------------------------------------------
  // Anchor restoration: after every render, stick to the bottom if the user is
  // there. The reading position across prepend / in-viewport reflow is held by
  // the browser's native scroll anchoring (overflow-anchor) now that every
  // loaded row stays in the DOM, so there is no JS message-anchor restore.
  // ---------------------------------------------------------------------------

  React.useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    // First render after a reset (channel switch or initial mount): jump
    // to the requested target message, or to the bottom by default.
    if (!hasInitializedRef.current) {
      if (isLoading) return;
      // The virtualized list owns the actual scroll node. Its API registers in
      // a child layout effect, after this parent hook's first pass; treating
      // that API-less pass as initialized writes to the inert outer wrapper
      // and permanently consumes the channel's initial bottom pin.
      if (virtualizerOwnsPrependAnchoring && !virtualScrollToBottom) return;
      // Establish the initial position before the browser paints. The follow-up
      // frame is a settling pass for content whose measurements land with the
      // commit (fonts, deferred rows, media), not the first bottom pin. Keeping
      // both writes in the shared scroll owner gives every conversation surface
      // the same first-frame behavior regardless of its surrounding animation.
      const pinToBottomOnMount = () => {
        scrollToBottomImperative("auto");
        mountPinRafIdRef.current = requestAnimationFrame(() => {
          mountPinRafIdRef.current = null;
          scrollToBottomImperative("auto");
        });
      };
      if (targetMessageId) {
        // A cold deep-link target may not be in the DOM on this first
        // commit — the route screen fetches it by id and splices it in a
        // render or two later. If centering fails now, leave the timeline at
        // its default position and let the post-mount target effect (keyed on
        // `messages`) retry once the row lands, rather than marking it handled.
        if (
          scrollToMessageImperative(targetMessageId, {
            highlight: highlightTargetMessage,
          })
        ) {
          handledTargetIdRef.current = targetMessageId;
          onTargetReached?.(targetMessageId);
        } else {
          pinToBottomOnMount();
        }
      } else if (
        initialMessageId &&
        messages.some((message) => message.id === initialMessageId)
      ) {
        // Resume reading where the reader left off instead of the newest post.
        // Own the viewport first: the channel reset assumed a bottom start,
        // and any later settle (row measurement, composer resize) must not
        // pull the reader to the floor while the row is brought into range.
        virtualCancelBottomIntent?.();
        virtualizerAtBottomRef.current = false;
        beginResumeGrace(container);
        // Virtua applies the resume on its next frame; check the landing
        // after that, while the grace still holds.
        mountPinRafIdRef.current = requestAnimationFrame(() => {
          mountPinRafIdRef.current = requestAnimationFrame(() => {
            mountPinRafIdRef.current = null;
            if (resumeGraceRef.current) followFloorIfResumedThere();
          });
        });
        anchorRef.current = {
          kind: "message",
          messageId: initialMessageId,
          topOffset: 0,
        };
        setIsAtBottom(false);
        // Virtua applies scroll requests on its next frame, so the list's own
        // open-time floor request is still queued here. Route the resume
        // through the same queue so it lands after (and wins over) that
        // request; a direct DOM scroll would be overwritten a frame later.
        const resumed =
          virtualizerOwnsPrependAnchoring && virtualScrollToMessage
            ? virtualScrollToMessage(initialMessageId, { behavior: "auto" })
            : scrollToMessageImperative(initialMessageId, { highlight: false });
        if (!resumed) {
          // Not mounted yet (only rows near the floor render on open): retry
          // as rows commit, like a deep-link target, but bounded.
          pendingResumeRef.current = {
            messageId: initialMessageId,
            attemptsLeft: RESUME_RETRY_LIMIT,
          };
        }
      } else {
        pinToBottomOnMount();
      }
      hasInitializedRef.current = true;
      prevLastMessageIdRef.current = messages[messages.length - 1]?.id;
      prevFirstMessageIdRef.current = messages[0]?.id;
      prevMessageCountRef.current = messages.length;
      prevMessagesRef.current = messages;
      return;
    }

    const anchor = anchorRef.current;
    const lastMessage = messages[messages.length - 1];
    const firstMessage = messages[0];
    const prevLastId = prevLastMessageIdRef.current;
    const prevCount = prevMessageCountRef.current;
    const newLatestArrived =
      lastMessage !== undefined && lastMessage.id !== prevLastId;
    // Count growth, not tail-id change, is the reliable "messages arrived"
    // signal. The relay can deliver a message that sorts ahead of an existing
    // same-second row, so the list grows without the *last* id changing —
    // `newLatestArrived` misses that case and the unread counter never bumps.
    const prevMessages = prevMessagesRef.current;
    const messagesArrived = messages.length - prevCount;
    const messageDelta = classifyTimelineMessageDelta({
      current: messages,
      previous: prevMessages,
    });
    const isPrepend = messageDelta === "prepend";

    // One-shot: an outbound send armed `scrollToBottomOnNextUpdate`. When the
    // resulting append lands, snap to bottom regardless of the current anchor,
    // then clear the flag. Bail before the anchored branch so the user's own
    // message pulls the view down.
    if (newLatestArrived && forceBottomOnNextAppendRef.current) {
      forceBottomOnNextAppendRef.current = false;
      anchorRef.current = { kind: "at-bottom" };
      settlingRef.current = true;
      if (virtualizerOwnsPrependAnchoring && virtualScrollToBottom) {
        virtualScrollToBottom("auto");
      } else {
        container.scrollTo({ top: container.scrollHeight, behavior: "auto" });
      }
      setIsAtBottom(true);
      setNewMessageCount(0);
      prevLastMessageIdRef.current = lastMessage?.id;
      prevFirstMessageIdRef.current = firstMessage?.id;
      prevMessageCountRef.current = messages.length;
      prevMessagesRef.current = messages;
      return;
    }

    // A head refresh (subscribe / reconnect) replaces the loaded window with
    // the newest page, which can drop the older rows a mid-history reader is
    // on. Hold the viewport and restore that row by loading older pages
    // rather than letting the view land wherever the remaining rows put it.
    const reading = anchor.kind === "message" ? anchor : readingRef.current;
    if (
      reading &&
      !lostReadingRef.current &&
      messages !== prevMessages &&
      !isPrepend &&
      !messages.some((message) => message.id === reading.messageId) &&
      prevMessages.some((message) => message.id === reading.messageId)
    ) {
      lostReadingRef.current = {
        messageId: reading.messageId,
        attemptsLeft: RESTORE_OLDER_PAGE_LIMIT,
        requestedFor: null,
      };
      virtualCancelBottomIntent?.();
      virtualizerAtBottomRef.current = false;
      anchorRef.current = {
        kind: "message",
        messageId: reading.messageId,
        topOffset: reading.topOffset,
      };
      beginResumeGrace(container);
      setIsAtBottom(false);
      prevLastMessageIdRef.current = lastMessage?.id;
      prevFirstMessageIdRef.current = firstMessage?.id;
      prevMessageCountRef.current = messages.length;
      prevMessagesRef.current = messages;
      return;
    }

    // The same refresh can instead trim older rows above a reader whose row
    // survives. Virtua keeps the scroll offset, so the view would slide down
    // by the removed height; put the reading row back at its offset.
    if (
      reading &&
      virtualizerOwnsPrependAnchoring &&
      !virtualizerAtBottomRef.current &&
      messages !== prevMessages &&
      !isPrepend &&
      firstMessage?.id !== prevFirstMessageIdRef.current &&
      messages.some((message) => message.id === reading.messageId)
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

    if (messages !== prevMessages && holdPositionOnNextAppendRef.current) {
      holdPositionOnNextAppendRef.current = false;
      if (
        messagesArrived > 0 &&
        !isPrepend &&
        anchor.kind !== "pinned-center"
      ) {
        // Output held back while the reader was scrolled up joins below the
        // old floor. Keep the reader where they are so they read on from the
        // first new post; the new-messages affordance still jumps to latest.
        virtualizerAtBottomRef.current = false;
        anchorRef.current = computeAnchor(container, false);
        setIsAtBottom(false);
        setNewMessageCount((current) => current + messagesArrived);
        prevLastMessageIdRef.current = lastMessage?.id;
        prevFirstMessageIdRef.current = firstMessage?.id;
        prevMessageCountRef.current = messages.length;
        prevMessagesRef.current = messages;
        return;
      }
    }

    if (anchor.kind === "pinned-center") {
      repinPinnedCenter();
    } else if (anchor.kind === "at-bottom") {
      if (
        virtualizerOwnsPrependAnchoring &&
        shouldSettleVirtualizedBottom({
          isAtBottom: virtualizerAtBottomRef.current,
          messageDelta,
          messagesArrived,
          messagesChanged: messages !== prevMessages,
        })
      ) {
        virtualSettleAtBottom?.();
      } else if (!virtualizerOwnsPrependAnchoring) {
        container.scrollTo({ top: container.scrollHeight, behavior: "auto" });
      }
      if (newLatestArrived) setNewMessageCount(0);
    } else if (
      messagesArrived > 0 &&
      !targetMessageId &&
      !virtualizerOwnsPrependAnchoring &&
      isAtBottomNow(container)
    ) {
      // A native scroll/layout callback may not have reconciled a stale
      // message anchor before this append commits. If the rendered result is
      // still physically at the floor (common in short threads), do not turn
      // that stale anchor into a visible unread affordance. Active navigation
      // targets own the viewport and must be preserved across presentation
      // reflow even when the old geometry momentarily reads as the floor.
      anchorRef.current = { kind: "at-bottom" };
      container.scrollTo({ top: container.scrollHeight, behavior: "auto" });
      setIsAtBottom(true);
      setNewMessageCount(0);
    } else if (messagesArrived > 0 && !virtualizerOwnsPrependAnchoring) {
      // Anchored mid-history. An older-history prepend grows the content above
      // the reading row; the browser's native scroll anchoring does NOT correct
      // this at the top edge (no anchor node above the viewport when scrollTop
      // is ~0), so re-pin the anchored row to its saved offset by id. This is
      // the single scroll writer for the prepend — the load-older observer only
      // triggers the fetch. We run it in this post-commit layout effect (not the
      // observer's promise callback) because the prepended rows commit on a
      // deferred snapshot a few frames later, so the row's true position is only
      // known here.
      const row = container.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(anchor.messageId)}"]`,
      );
      if (row) {
        const currentTopOffset =
          row.getBoundingClientRect().top -
          container.getBoundingClientRect().top;
        const drift = currentTopOffset - anchor.topOffset;
        if (Math.abs(drift) > 0.5) {
          container.scrollBy(0, drift);
        }
      }
      if (!isPrepend) {
        setNewMessageCount((current) => current + messagesArrived);
      }
    }

    prevLastMessageIdRef.current = lastMessage?.id;
    prevFirstMessageIdRef.current = firstMessage?.id;
    prevMessageCountRef.current = messages.length;
    prevMessagesRef.current = messages;
  }, [
    beginResumeGrace,
    followFloorIfResumedThere,
    highlightTargetMessage,
    initialMessageId,
    isLoading,
    messages,
    onTargetReached,
    repinPinnedCenter,
    scrollContainerRef,
    scrollToBottomImperative,
    scrollToMessageImperative,
    targetMessageId,
    virtualCancelBottomIntent,
    virtualScrollToBottom,
    virtualScrollToMessage,
    virtualSettleAtBottom,
    virtualizerOwnsPrependAnchoring,
  ]);

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
  }, [messages, scrollToMessageImperative, virtualizerRenderVersion]);

  // Restore a reading position a head refresh dropped: load older pages (a
  // bounded number) until its row is back, then return the reader to it. The
  // reader taking over, or history running out, ends the attempt.
  React.useEffect(() => {
    const lost = lostReadingRef.current;
    if (!lost) return;
    if (!resumeGraceRef.current) {
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
      endResumeGrace();
    }
  }, [
    endResumeGrace,
    messages,
    requestOlder,
    scrollToMessageImperative,
    virtualScrollToMessage,
    virtualizerOwnsPrependAnchoring,
  ]);

  // ---------------------------------------------------------------------------
  // Content resize: while stuck to the bottom, an in-viewport reflow (image
  // decode, embed expand, late font load) that React isn't driving grows
  // `scrollHeight` without a `messages` change, so the layout effect doesn't
  // fire — re-pin to the new floor here to stay glued. When anchored
  // mid-history, native scroll anchoring (overflow-anchor) holds the reading
  // row across the reflow, so there's nothing to do.
  // ---------------------------------------------------------------------------
  // biome-ignore lint/correctness/useExhaustiveDependencies: channelId deliberately re-subscribes after a keyed or conditional scroll-content mount replaces ref.current.
  React.useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const container = scrollContainerRef.current;
      if (!container) return;
      if (settleAtBottomAfterLayout()) return;
      if (
        anchorRef.current.kind === "at-bottom" &&
        !virtualizerOwnsPrependAnchoring
      ) {
        container.scrollTo({ top: container.scrollHeight, behavior: "auto" });
      }
    });
    observer.observe(content);
    const container = scrollContainerRef.current;
    if (container && container !== content) observer.observe(container);
    return () => {
      observer.disconnect();
      if (targetSettleRafRef.current !== null) {
        cancelAnimationFrame(targetSettleRafRef.current);
        targetSettleRafRef.current = null;
      }
    };
  }, [
    channelId,
    contentRef,
    scrollContainerRef,
    settleAtBottomAfterLayout,
    virtualizerOwnsPrependAnchoring,
  ]);

  useVirtualizedViewportResize(
    scrollContainerRef,
    virtualizerAtBottomRef,
    virtualizerOwnsPrependAnchoring ? virtualSettleAtBottom : undefined,
  );

  // Pinned centers survive our own corrections but release as soon as the
  // reader deliberately takes control of the scroll position or the caller
  // retires the temporary target after layout settlement.
  React.useEffect(() => {
    if (!pinTargetCentered) releasePinnedCenter();
  }, [pinTargetCentered, releasePinnedCenter]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: channelId deliberately re-subscribes after a keyed or conditional scroll-container mount replaces ref.current.
  React.useEffect(() => {
    if (!pinTargetCentered) return;
    const container = scrollContainerRef.current;
    if (!container) return;

    const handleUserInteraction = () => {
      const pinnedMessageId =
        anchorRef.current.kind === "pinned-center"
          ? anchorRef.current.messageId
          : null;
      releasePinnedCenter();
      if (pinnedMessageId) onTargetSettled?.(pinnedMessageId);
    };
    container.addEventListener("wheel", handleUserInteraction, {
      passive: true,
    });
    container.addEventListener("touchstart", handleUserInteraction, {
      passive: true,
    });
    container.addEventListener("keydown", handleUserInteraction);
    return () => {
      container.removeEventListener("wheel", handleUserInteraction);
      container.removeEventListener("touchstart", handleUserInteraction);
      container.removeEventListener("keydown", handleUserInteraction);
    };
  }, [
    channelId,
    onTargetSettled,
    pinTargetCentered,
    releasePinnedCenter,
    scrollContainerRef,
  ]);

  // ---------------------------------------------------------------------------
  // Target message handling (deep link, jump-to-reply, etc.). Distinct from
  // the initial-mount target above — this handles changes after the first
  // render.
  //
  // A deep-link target may live in older history that isn't in the DOM when
  // the route param first changes. The route screen fetches the target event
  // by id and splices it into `messages` asynchronously, so its row appears a
  // render or two later. We therefore key this effect on `messages` and bail
  // *without* marking the target handled until its row actually exists — each
  // subsequent message commit re-runs the effect and retries the centering.
  // ---------------------------------------------------------------------------
  // biome-ignore lint/correctness/useExhaustiveDependencies: `messages` and `virtualizerRenderVersion` are intentional retry triggers, not values read by the effect body — the effect reads the DOM (querySelector), and we need it to re-run each time the message list or virtualized rendered range changes so a target spliced into older history gets centered once its row commits.
  React.useEffect(() => {
    if (!targetMessageId) {
      handledTargetIdRef.current = null;
      releasePinnedCenter();
      return;
    }
    if (
      anchorRef.current.kind === "pinned-center" &&
      anchorRef.current.messageId !== targetMessageId
    ) {
      releasePinnedCenter();
    }
    if (handledTargetIdRef.current === targetMessageId || isLoading) return;
    if (!hasInitializedRef.current) return; // initial-mount path will handle.

    void virtualizerRenderVersion;
    const container = scrollContainerRef.current;
    if (!container) return;
    const el = container.querySelector<HTMLElement>(
      `[data-message-id="${targetMessageId}"]`,
    );
    if (!el && virtualizerOwnsPrependAnchoring) {
      if (
        scrollToMessageImperative(targetMessageId, {
          highlight: highlightTargetMessage,
        })
      ) {
        handledTargetIdRef.current = targetMessageId;
        onTargetReached?.(targetMessageId);
      }
      return;
    }
    if (!el) {
      // Row not in the DOM yet. A cold deep-link target is fetched by id and
      // spliced into `messages` a render or two later; this effect re-runs on
      // each `messages` commit and retries until the row exists.
      return;
    }
    handledTargetIdRef.current = targetMessageId;
    scrollToMessageImperative(targetMessageId, {
      highlight: highlightTargetMessage,
    });
    onTargetReached?.(targetMessageId);
  }, [
    highlightTargetMessage,
    isLoading,
    messages,
    onTargetReached,
    releasePinnedCenter,
    scrollContainerRef,
    scrollToMessageImperative,
    targetMessageId,
    virtualizerOwnsPrependAnchoring,
    virtualizerRenderVersion,
  ]);

  React.useEffect(() => {
    return () => {
      if (highlightTimeoutRef.current !== null) {
        window.clearTimeout(highlightTimeoutRef.current);
      }
      detachResumeGraceRef.current?.();
      detachResumeGraceRef.current = null;
      if (programmaticScrollRafRef.current !== null) {
        cancelAnimationFrame(programmaticScrollRafRef.current);
      }
      if (targetSettleRafRef.current !== null) {
        cancelAnimationFrame(targetSettleRafRef.current);
      }
    };
  }, []);

  const onVirtualizerAtBottomStateChange = React.useCallback(
    (atBottom: boolean) => {
      if (!virtualizerOwnsPrependAnchoring) return;
      // A resume owns the viewport until it has visibly left the floor or the
      // reader acts: the list can still report the floor it was pinned to
      // before the resume took over, and that stale report must not hand the
      // viewport back to the bottom.
      if (resumeGraceRef.current) {
        if (atBottom) return;
        if (!lostReadingRef.current) endResumeGrace();
      }
      if (atBottom) {
        readingRef.current = null;
      } else {
        const position = virtualReadingPosition?.();
        const container = scrollContainerRef.current;
        const row =
          position && container
            ? container.querySelector<HTMLElement>(
                `[data-message-id="${CSS.escape(position.messageId)}"]`,
              )
            : null;
        readingRef.current = position
          ? {
              messageId: position.messageId,
              // Measure the one reading row so the later correction compares
              // like with like (Virtua offsets exclude list padding).
              topOffset:
                row && container
                  ? row.getBoundingClientRect().top -
                    container.getBoundingClientRect().top
                  : position.topOffset,
            }
          : readingRef.current;
      }
      virtualizerAtBottomRef.current = atBottom;
      if (atBottom) {
        anchorRef.current = { kind: "at-bottom" };
        setNewMessageCount(0);
      }
      setIsAtBottom(atBottom);
    },
    [
      endResumeGrace,
      scrollContainerRef,
      virtualReadingPosition,
      virtualizerOwnsPrependAnchoring,
    ],
  );

  return {
    onScroll,
    isAtBottom,
    newMessageCount,
    highlightedMessageId,
    scrollToBottom: scrollToBottomImperative,
    settleAtBottomAfterLayout,
    scrollToBottomOnNextUpdate,
    holdPositionOnNextAppend,
    isFollowingBottom,
    scrollToMessage: scrollToMessageImperative,
    onVirtualizerAtBottomStateChange,
  };
}
