"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { RoomStatus } from "@/generated/prisma/enums";

export function RoomEndPanel({
  roomId,
  status,
}: {
  roomId: string;
  status: RoomStatus;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(status === "ENDING");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function end() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/rooms/${encodeURIComponent(roomId)}/end`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      const result = await response.json();
      if (!response.ok)
        throw new Error(
          result.error ?? "The room could not be fully ended. Retry safely.",
        );
      router.refresh();
    } catch (reason) {
      setConfirming(true);
      setError(
        reason instanceof Error
          ? reason.message
          : "The room could not be fully ended. Retry safely.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <section
      className="detail-panel room-end-panel"
      aria-labelledby="end-title"
    >
      <div>
        <h2 id="end-title">
          {status === "ENDING" ? "Room is closing" : "End this discussion"}
        </h2>
        <p className="field-hint">
          Ending blocks new entry, disconnects every media identity, and keeps
          the discussion history.
        </p>
      </div>
      {!confirming ? (
        <button
          className="button button-secondary button-small"
          type="button"
          onClick={() => setConfirming(true)}
        >
          End room
        </button>
      ) : (
        <div className="room-end-actions">
          <button
            className="button button-small"
            type="button"
            disabled={pending}
            onClick={() => void end()}
          >
            {pending
              ? "Ending…"
              : status === "ENDING"
                ? "Retry media teardown"
                : "End room for everyone"}
          </button>
          {status !== "ENDING" && (
            <button
              className="button button-secondary button-small"
              type="button"
              disabled={pending}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
          )}
        </div>
      )}
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
