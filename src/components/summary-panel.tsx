"use client";

import { useCallback, useEffect, useState } from "react";
import type { SummarySnapshot } from "@/lib/summary-input";
import { LatestRead } from "@/lib/client-refresh";
import { useRoomPolling } from "./use-room-polling";

export function SummaryPanel({
  roomId,
  canGenerate,
}: {
  roomId: string;
  canGenerate: boolean;
}) {
  const [summary, setSummary] = useState<SummarySnapshot | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reads] = useState(() => new LatestRead());
  const endpoint = `/api/rooms/${encodeURIComponent(roomId)}/summary`;

  const load = useCallback(
    async (signal?: AbortSignal) => {
      await reads.run(
        async () => {
          const response = await fetch(endpoint, {
            cache: "no-store",
            signal: signal
              ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
              : AbortSignal.timeout(15_000),
          });
          const result = await response.json();
          if (!response.ok)
            throw new Error(
              result.error ?? "Couldn't load the session summary.",
            );
          return result as SummarySnapshot;
        },
        (result) => {
          setSummary(result);
          setError(null);
        },
      );
    },
    [endpoint, reads],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).catch((reason) => {
      if (!controller.signal.aborted)
        setError(
          reason instanceof Error
            ? reason.message
            : "Couldn't load the session summary.",
        );
    });
    return () => {
      controller.abort();
      reads.invalidate();
    };
  }, [load, reads]);
  useRoomPolling(
    (!summary || summary.status === "GENERATING") && !pending,
    load,
  );

  async function generate() {
    setPending(true);
    setError(null);
    reads.invalidate();
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(45_000),
      });
      const result = await response.json();
      if (!response.ok) {
        await load().catch(() => {});
        throw new Error(result.error ?? "Couldn't generate the summary.");
      }
      reads.invalidate();
      setSummary(result);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Couldn't generate the summary.",
      );
    } finally {
      setPending(false);
    }
  }

  const status = pending ? "GENERATING" : (summary?.status ?? "PENDING");
  return (
    <section
      className="detail-panel summary-panel"
      aria-labelledby="summary-title"
    >
      <div className="summary-heading">
        <div>
          <p className="eyebrow">Written chat only</p>
          <h2 id="summary-title">Session summary</h2>
        </div>
        <span className="status-badge">{status}</span>
      </div>
      {summary?.status === "READY" && summary.content ? (
        <>
          <div className="summary-content">{summary.content}</div>
          <p className="field-hint">
            Based on {summary.sourceMessageCount ?? 0} chat messages ·{" "}
            {summary.model} · {summary.promptTokens ?? 0} input /{" "}
            {summary.completionTokens ?? 0} output tokens
          </p>
        </>
      ) : (
        <p className="muted">
          {status === "GENERATING"
            ? "Generating from the saved room chat. This page will refresh automatically."
            : summary?.status === "FAILED"
              ? summary.error
              : "No summary has been generated for this discussion yet."}
        </p>
      )}
      {canGenerate && summary?.status !== "READY" && (
        <button
          className="button button-small"
          type="button"
          disabled={pending || !summary || summary.status === "GENERATING"}
          onClick={() => void generate()}
        >
          {pending || summary?.status === "GENERATING"
            ? "Generating…"
            : summary?.status === "FAILED"
              ? "Retry summary"
              : "Generate summary"}
        </button>
      )}
      <button
        className="button button-secondary button-small"
        type="button"
        disabled={pending}
        onClick={() =>
          void load().catch(() =>
            setError("Couldn't refresh the summary. Try again."),
          )
        }
      >
        Refresh summary
      </button>
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
