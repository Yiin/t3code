import { type LegendListRef } from "@legendapp/list/react";
import { Debouncer } from "@tanstack/react-pacer";
import { useCallback, useEffect, useRef, useState } from "react";
import { CHAT_LIST_ANCHOR_OFFSET } from "@t3tools/shared/chatList";
import type { MessageId } from "@t3tools/contracts";
import { getAnchoredTurnMetrics, type TimelineScrollMode } from "./timelineScrollAnchoring";

type TimelineEntries = readonly unknown[];

export function useTimelineScrollSync({
  activeThreadId,
  timelineEntries,
  composerOverlayHeight,
}: {
  readonly activeThreadId: string | null | undefined;
  readonly timelineEntries: TimelineEntries;
  readonly composerOverlayHeight: number;
}) {
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const legendListRef = useRef<LegendListRef | null>(null);
  const timelineScrollToRowRef = useRef<((rowId: string) => void) | null>(null);
  const isAtEndRef = useRef(true);
  const showScrollDebouncer = useRef(
    new Debouncer(() => setShowScrollToBottom(true), { wait: 150 }),
  );
  const timelineScrollModeRef = useRef<TimelineScrollMode>("following-end");
  const pendingTimelineAnchorRef = useRef<MessageId | null>(null);
  const positionedTimelineAnchorRef = useRef<MessageId | null>(null);
  const settledTimelineAnchorRef = useRef<MessageId | null>(null);
  const activeTimelineAnchorIndexRef = useRef<number | null>(null);
  const anchorUserScrollGenerationRef = useRef(0);
  const liveFollowUserScrollGenerationRef = useRef<number | null>(0);
  const pendingAnchorScrollRestoreRef = useRef<{
    readonly messageId: MessageId;
    readonly offset: number;
    readonly userScrollGeneration: number;
  } | null>(null);
  const anchorScrollRestoreFrameRef = useRef<number | null>(null);

  const cancelTimelineLiveFollowForUserNavigation = useCallback(() => {
    anchorUserScrollGenerationRef.current += 1;
    timelineScrollModeRef.current = "free-scrolling";
    liveFollowUserScrollGenerationRef.current = null;
    pendingTimelineAnchorRef.current = null;
    positionedTimelineAnchorRef.current = null;
    settledTimelineAnchorRef.current = null;
    activeTimelineAnchorIndexRef.current = null;
    pendingAnchorScrollRestoreRef.current = null;
    if (anchorScrollRestoreFrameRef.current !== null) {
      cancelAnimationFrame(anchorScrollRestoreFrameRef.current);
      anchorScrollRestoreFrameRef.current = null;
    }
  }, []);
  const cancelRef = useRef(cancelTimelineLiveFollowForUserNavigation);
  useEffect(() => {
    cancelRef.current = cancelTimelineLiveFollowForUserNavigation;
  }, [cancelTimelineLiveFollowForUserNavigation]);

  const getActiveTimelineTurnMetrics = useCallback(
    (list?: LegendListRef | null) => {
      const resolvedList = list ?? legendListRef.current;
      const anchorIndex = activeTimelineAnchorIndexRef.current;
      const state = resolvedList?.getState();
      if (!resolvedList || !state || anchorIndex === null) return null;
      return getAnchoredTurnMetrics({
        state,
        anchorIndex,
        composerOverlayHeight,
        anchorOffset: CHAT_LIST_ANCHOR_OFFSET,
      });
    },
    [composerOverlayHeight],
  );
  const timelineRealContentOverflowsViewport = useCallback(
    (list?: LegendListRef | null) => {
      const resolvedList = list ?? legendListRef.current;
      const state = resolvedList?.getState();
      if (!resolvedList || !state || state.data.length === 0) return false;
      const lastRowIndex = state.data.length - 1;
      const lastRowTop = state.positionAtIndex(lastRowIndex);
      const lastRowHeight = state.sizeAtIndex(lastRowIndex);
      if (
        typeof lastRowTop !== "number" ||
        typeof lastRowHeight !== "number" ||
        !Number.isFinite(lastRowTop) ||
        !Number.isFinite(lastRowHeight)
      )
        return false;
      const realContentBottom = lastRowTop + Math.max(1, lastRowHeight);
      const visibleScrollLength = Math.max(
        0,
        (state.scrollLength ?? 0) - composerOverlayHeight - CHAT_LIST_ANCHOR_OFFSET,
      );
      return realContentBottom > visibleScrollLength;
    },
    [composerOverlayHeight],
  );

  const scrollToEnd = useCallback((animated = false) => {
    isAtEndRef.current = true;
    timelineScrollModeRef.current = "following-end";
    liveFollowUserScrollGenerationRef.current = anchorUserScrollGenerationRef.current;
    pendingTimelineAnchorRef.current = null;
    activeTimelineAnchorIndexRef.current = null;
    showScrollDebouncer.current.cancel();
    setShowScrollToBottom(false);
    void legendListRef.current?.scrollToEnd?.({ animated });
  }, []);

  useEffect(() => {
    let removeListeners: (() => void) | null = null;
    const frame = requestAnimationFrame(() => {
      const scrollNode = legendListRef.current?.getScrollableNode();
      if (!scrollNode) return;
      const handleManualNavigation = () => cancelRef.current();
      scrollNode.addEventListener("wheel", handleManualNavigation, { passive: true });
      scrollNode.addEventListener("touchmove", handleManualNavigation, { passive: true });
      scrollNode.addEventListener("pointerdown", handleManualNavigation, { passive: true });
      removeListeners = () => {
        scrollNode.removeEventListener("wheel", handleManualNavigation);
        scrollNode.removeEventListener("touchmove", handleManualNavigation);
        scrollNode.removeEventListener("pointerdown", handleManualNavigation);
      };
    });
    return () => {
      cancelAnimationFrame(frame);
      removeListeners?.();
    };
  }, [activeThreadId]);

  const onTimelineAnchorReady = useCallback((messageId: MessageId, anchorIndex: number) => {
    if (pendingTimelineAnchorRef.current === messageId) pendingTimelineAnchorRef.current = null;
    activeTimelineAnchorIndexRef.current = anchorIndex;
    if (positionedTimelineAnchorRef.current === messageId) return;
    positionedTimelineAnchorRef.current = messageId;
    settledTimelineAnchorRef.current = null;
    const positionAnchor = (remainingAttempts: number) => {
      requestAnimationFrame(() => {
        if (positionedTimelineAnchorRef.current !== messageId) return;
        const list = legendListRef.current;
        if (!list) {
          if (remainingAttempts > 0) positionAnchor(remainingAttempts - 1);
          return;
        }
        const scrollNode = list.getScrollableNode();
        let finished = false;
        const finishAnimatedPositioning = () => {
          if (finished) return;
          finished = true;
          window.clearTimeout(fallbackTimer);
          scrollNode.removeEventListener("scrollend", finishAnimatedPositioning);
          if (positionedTimelineAnchorRef.current !== messageId) return;
          void list.scrollToOffset({ offset: list.getState().scroll, animated: false });
          settledTimelineAnchorRef.current = messageId;
        };
        const fallbackTimer = window.setTimeout(finishAnimatedPositioning, 750);
        scrollNode.addEventListener("scrollend", finishAnimatedPositioning, { once: true });
        void list.scrollToIndex({
          index: anchorIndex,
          animated: true,
          viewPosition: 0,
          viewOffset: CHAT_LIST_ANCHOR_OFFSET,
        });
      });
    };
    requestAnimationFrame(() => positionAnchor(12));
  }, []);

  const onTimelineAnchorSizeChanged = useCallback((messageId: MessageId) => {
    if (settledTimelineAnchorRef.current !== messageId) return;
    if (liveFollowUserScrollGenerationRef.current === anchorUserScrollGenerationRef.current) return;
    const scrollOffset = legendListRef.current?.getState().scroll;
    if (scrollOffset === undefined) return;
    if (pendingAnchorScrollRestoreRef.current === null) {
      pendingAnchorScrollRestoreRef.current = {
        messageId,
        offset: scrollOffset,
        userScrollGeneration: anchorUserScrollGenerationRef.current,
      };
    }
    if (anchorScrollRestoreFrameRef.current !== null) return;
    anchorScrollRestoreFrameRef.current = requestAnimationFrame(() => {
      anchorScrollRestoreFrameRef.current = null;
      const pending = pendingAnchorScrollRestoreRef.current;
      pendingAnchorScrollRestoreRef.current = null;
      if (
        pending &&
        settledTimelineAnchorRef.current === pending.messageId &&
        pending.userScrollGeneration === anchorUserScrollGenerationRef.current
      ) {
        const list = legendListRef.current;
        const currentScrollOffset = list?.getState().scroll;
        if (
          typeof currentScrollOffset === "number" &&
          Math.abs(currentScrollOffset - pending.offset) <= 2
        ) {
          void list?.scrollToOffset({ offset: pending.offset, animated: false });
        }
      }
    });
  }, []);

  const onIsAtEndChange = useCallback((isAtEnd: boolean) => {
    if (
      !isAtEnd &&
      liveFollowUserScrollGenerationRef.current === anchorUserScrollGenerationRef.current
    ) {
      showScrollDebouncer.current.cancel();
      setShowScrollToBottom(false);
      return;
    }
    if (isAtEndRef.current === isAtEnd) return;
    isAtEndRef.current = isAtEnd;
    if (isAtEnd) {
      timelineScrollModeRef.current = "following-end";
      liveFollowUserScrollGenerationRef.current = anchorUserScrollGenerationRef.current;
      showScrollDebouncer.current.cancel();
      setShowScrollToBottom(false);
    } else {
      timelineScrollModeRef.current = "free-scrolling";
      liveFollowUserScrollGenerationRef.current = null;
      showScrollDebouncer.current.maybeExecute();
    }
  }, []);

  useEffect(() => {
    if (
      !activeThreadId ||
      liveFollowUserScrollGenerationRef.current !== anchorUserScrollGenerationRef.current
    )
      return;
    let secondFrame: number | null = null;
    const frame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        if (liveFollowUserScrollGenerationRef.current !== anchorUserScrollGenerationRef.current)
          return;
        if (pendingTimelineAnchorRef.current !== null) return;
        if (
          positionedTimelineAnchorRef.current !== null &&
          settledTimelineAnchorRef.current !== positionedTimelineAnchorRef.current
        )
          return;
        const list = legendListRef.current;
        if (!list) return;
        if (timelineScrollModeRef.current === "anchoring-new-turn") {
          const metrics = getActiveTimelineTurnMetrics(list);
          if (!metrics || metrics.scrollDeltaToRevealEnd <= 1) return;
          void list.scrollToOffset({
            offset: list.getState().scroll + metrics.scrollDeltaToRevealEnd,
            animated: false,
          });
          return;
        }
        if (
          timelineScrollModeRef.current !== "following-end" ||
          !timelineRealContentOverflowsViewport(list)
        )
          return;
        void list.scrollToEnd?.({ animated: false });
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      if (secondFrame !== null) cancelAnimationFrame(secondFrame);
    };
  }, [
    activeThreadId,
    timelineEntries,
    getActiveTimelineTurnMetrics,
    timelineRealContentOverflowsViewport,
  ]);

  useEffect(() => {
    isAtEndRef.current = true;
    timelineScrollModeRef.current = "following-end";
    liveFollowUserScrollGenerationRef.current = anchorUserScrollGenerationRef.current;
    pendingTimelineAnchorRef.current = null;
    positionedTimelineAnchorRef.current = null;
    settledTimelineAnchorRef.current = null;
    activeTimelineAnchorIndexRef.current = null;
    showScrollDebouncer.current.cancel();
    setShowScrollToBottom(false);
  }, [activeThreadId]);

  const beginTimelineAnchor = useCallback((messageId: MessageId) => {
    isAtEndRef.current = true;
    timelineScrollModeRef.current = "anchoring-new-turn";
    liveFollowUserScrollGenerationRef.current = anchorUserScrollGenerationRef.current;
    pendingTimelineAnchorRef.current = messageId;
    activeTimelineAnchorIndexRef.current = null;
    showScrollDebouncer.current.cancel();
    setShowScrollToBottom(false);
  }, []);

  return {
    legendListRef,
    timelineScrollToRowRef,
    showScrollToBottom,
    scrollToEnd,
    beginTimelineAnchor,
    onTimelineAnchorReady,
    onTimelineAnchorSizeChanged,
    onIsAtEndChange,
    cancelTimelineLiveFollowForUserNavigation,
  };
}
