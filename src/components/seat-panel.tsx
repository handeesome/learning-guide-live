"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { copy, seatCopy } from "@/lib/content";
import type { SeatStatus } from "@/lib/seat-input";
import { useRoomPolling } from "./use-room-polling";

export function SeatPanel({ roomId }: { roomId: string }) {
  const [clientId, setClientId] = useState("");
  const [data, setData] = useState<SeatStatus | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [pending, setPending] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const owned = useRef<string | null>(null);
  const endpoint = `/api/rooms/${encodeURIComponent(roomId)}/seat`;

  // A fresh document gets its own ID, even if sessionStorage was cloned by
  // Duplicate Tab. IDs are not credentials; the server still requires Session.
  useEffect(() => setClientId(crypto.randomUUID()), []);

  const applyStatus = useCallback((result: SeatStatus) => {
    if (
      owned.current &&
      result.reservation &&
      !result.reservation.ownedByThisPage
    ) {
      setNotice(seatCopy.replaced);
    }
    owned.current = result.reservation?.ownedByThisPage
      ? result.reservation.id
      : null;
    setData(result);
  }, []);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      let message: string = seatCopy.refreshFailed;
      try {
        const response = await fetch(endpoint, {
          cache: "no-store",
          headers: { "X-Room-Client": clientId },
          signal,
        });
        const result = await response.json();
        if (signal?.aborted) return;
        if (!response.ok) {
          message = result.error ?? message;
          if (response.status === 401) setNeedsSignIn(true);
          if ([401, 403, 404, 409].includes(response.status)) {
            setUnavailable(true);
            setData(null);
          }
          throw new Error("seat-refresh-failed");
        }
        applyStatus(result);
        setRefreshError(null);
      } catch (error) {
        if (signal?.aborted) return;
        setRefreshError(message);
        throw error;
      }
    },
    [endpoint, clientId, applyStatus],
  );

  useEffect(() => {
    if (!clientId) return;
    const controller = new AbortController();
    void load(controller.signal)
      .catch(() => {})
      .finally(() => {
        if (!controller.signal.aborted) setInitializing(false);
      });
    return () => controller.abort();
  }, [clientId, load]);
  // Polls only read state: no hidden renewals, auto-claims or unload releases.
  useRoomPolling(!!clientId && !initializing && !pending && !unavailable, load);

  async function refresh() {
    setPending(true);
    await load().catch(() => {});
    setPending(false);
  }

  async function change(release: boolean) {
    if (!data) return;
    setPending(true);
    setActionError(null);
    setNotice("");
    try {
      const mediaRelease = release && data.mediaHeld;
      const response = await fetch(
        mediaRelease
          ? `/api/rooms/${encodeURIComponent(roomId)}/token`
          : endpoint,
        {
          method: release ? "DELETE" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            release
              ? { clientId, reservationId: data.reservation?.id }
              : {
                  clientId,
                  previousReservationId: data.reservation?.id ?? null,
                },
          ),
        },
      );
      const result = await response.json();
      if (!response.ok) {
        setActionError(result.error ?? seatCopy.failed);
        await load().catch(() => {});
      } else {
        if (mediaRelease) await load();
        else applyStatus(result);
        setRefreshError(null);
        setNotice(
          release
            ? result.released
              ? mediaRelease
                ? seatCopy.mediaReleased
                : seatCopy.cancelled
              : seatCopy.replaced
            : seatCopy.saved,
        );
      }
    } catch {
      setActionError(seatCopy.failed);
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="room-entry stack-form" aria-labelledby="seat-title">
      <h3 id="seat-title">{seatCopy.title}</h3>
      <p className="field-hint">{seatCopy.help}</p>
      <p className="field-hint">{seatCopy.preview}</p>
      {!data && !refreshError && (
        <p className="field-hint">{seatCopy.loading}</p>
      )}
      {data && (
        <>
          <p role="status">
            {data.occupied} / {data.capacity} seats held
          </p>
          {data.mediaHeld ? (
            <>
              <p className="field-hint">{seatCopy.mediaHeld}</p>
              {data.reservation?.ownedByThisPage && (
                <button
                  className="button button-secondary"
                  disabled={pending}
                  onClick={() => change(true)}
                >
                  {pending ? seatCopy.saving : seatCopy.releaseMedia}
                </button>
              )}
            </>
          ) : data.active ? (
            <p className="field-hint">{seatCopy.active}</p>
          ) : (
            <>
              {data.reservation ? (
                <>
                  <p className="field-hint">
                    {data.reservation.ownedByThisPage
                      ? "Reserved until "
                      : "Reservation expires at "}
                    <time dateTime={data.reservation.expiresAt}>
                      {new Date(
                        data.reservation.expiresAt,
                      ).toLocaleTimeString()}
                    </time>
                    .
                  </p>
                  {!data.reservation.ownedByThisPage && (
                    <p className="field-hint">{seatCopy.elsewhere}</p>
                  )}
                </>
              ) : (
                <p className="field-hint">
                  {data.available ? seatCopy.available : seatCopy.full}
                </p>
              )}
              {data.reservation?.ownedByThisPage ? (
                <button
                  className="button button-secondary"
                  disabled={pending}
                  onClick={() => change(true)}
                >
                  {pending ? seatCopy.saving : seatCopy.cancel}
                </button>
              ) : (
                <button
                  className="button"
                  disabled={
                    pending || (!data.reservation && data.available === 0)
                  }
                  onClick={() => change(false)}
                >
                  {pending
                    ? seatCopy.saving
                    : data.reservation
                      ? seatCopy.takeover
                      : seatCopy.reserve}
                </button>
              )}
            </>
          )}
        </>
      )}
      <button
        className="button button-secondary button-small"
        disabled={initializing || pending || unavailable}
        onClick={refresh}
      >
        {seatCopy.refresh}
      </button>
      {notice && (
        <p className="field-hint" role="status">
          {notice}
        </p>
      )}
      {actionError && (
        <p className="error-message" role="alert">
          {actionError}
        </p>
      )}
      {refreshError && (
        <p className="error-message" role="alert">
          {refreshError}
        </p>
      )}
      {needsSignIn && (
        <Link
          className="button button-secondary"
          href={`/sign-in?next=${encodeURIComponent(`/rooms/${roomId}`)}`}
        >
          {copy.signIn}
        </Link>
      )}
    </section>
  );
}
