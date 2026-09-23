"use client";

import { useEffect, useRef } from "react";

// Polish Session E — two related touch gestures sharing one shape (track a
// touch's start point, compare it to where it ended, fire a callback past a
// threshold), so both live here instead of as two near-duplicate hooks.

const SWIPE_THRESHOLD_PX = 70;
const MAX_CROSS_AXIS_DRIFT_PX = 60;

// Edge-swipe-to-go-back — the same affordance iOS's own back gesture uses:
// only arms when the touch STARTS within a thin zone at the left edge, so
// an ordinary horizontal drag/scroll anywhere else on the page (a carousel,
// selecting text) never gets mistaken for "go back".
const EDGE_ZONE_PX = 24;

export function useSwipeBack(onBack: () => void, enabled: boolean = true) {
  const start = useRef<{ x: number; y: number } | null>(null);
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;

  useEffect(() => {
    if (!enabled) return;
    function handleStart(e: TouchEvent) {
      const t = e.touches[0];
      start.current = t.clientX <= EDGE_ZONE_PX ? { x: t.clientX, y: t.clientY } : null;
    }
    function handleEnd(e: TouchEvent) {
      if (!start.current) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - start.current.x;
      const dy = Math.abs(t.clientY - start.current.y);
      start.current = null;
      if (dx > SWIPE_THRESHOLD_PX && dy < MAX_CROSS_AXIS_DRIFT_PX) onBackRef.current();
    }
    document.addEventListener("touchstart", handleStart, { passive: true });
    document.addEventListener("touchend", handleEnd, { passive: true });
    return () => {
      document.removeEventListener("touchstart", handleStart);
      document.removeEventListener("touchend", handleEnd);
    };
  }, [enabled]);
}

// Swipe-down-to-dismiss for a bottom sheet / overlay — scoped to a
// container ref (unlike useSwipeBack's document-wide edge zone) since a
// sheet's own drag handle area is exactly where this should fire, not the
// whole page.
export function useSwipeDismiss<T extends HTMLElement>(onDismiss: () => void, enabled: boolean = true) {
  const ref = useRef<T | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    const node = ref.current;
    if (!node || !enabled) return;
    function handleStart(e: TouchEvent) {
      const t = e.touches[0];
      start.current = { x: t.clientX, y: t.clientY };
    }
    function handleEnd(e: TouchEvent) {
      if (!start.current) return;
      const t = e.changedTouches[0];
      const dy = t.clientY - start.current.y;
      const dx = Math.abs(t.clientX - start.current.x);
      start.current = null;
      if (dy > SWIPE_THRESHOLD_PX && dx < MAX_CROSS_AXIS_DRIFT_PX) onDismissRef.current();
    }
    node.addEventListener("touchstart", handleStart, { passive: true });
    node.addEventListener("touchend", handleEnd, { passive: true });
    return () => {
      node.removeEventListener("touchstart", handleStart);
      node.removeEventListener("touchend", handleEnd);
    };
  }, [enabled]);

  return ref;
}
