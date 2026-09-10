"use client";

import { useEffect, useRef } from "react";

/** One request at a time; hidden tabs pause network work and failures back off. */
export function useRoomPolling(
  enabled: boolean,
  refresh: (signal: AbortSignal) => Promise<void>,
) {
  const latest = useRef(refresh);
  useEffect(() => {
    latest.current = refresh;
  }, [refresh]);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let delay = 5000;
    let timer: ReturnType<typeof setTimeout>;
    async function tick() {
      if (document.visibilityState !== "hidden") {
        try {
          await latest.current(controller.signal);
          delay = 5000;
        } catch {
          delay = Math.min(delay * 2, 30_000);
        }
      }
      if (!controller.signal.aborted) timer = setTimeout(tick, delay);
    }
    timer = setTimeout(tick, delay);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [enabled]);
}
