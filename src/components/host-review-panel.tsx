"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { copy, memberRoleLabels, memberStatusLabels } from "@/lib/content";
import type { ReviewQueue } from "@/lib/review-input";
import { useRoomPolling } from "./use-room-polling";

export function HostReviewPanel({ roomId }: { roomId: string }) {
  const [data, setData] = useState<ReviewQueue | null>(null);
  const [pending, setPending] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const base = `/api/rooms/${encodeURIComponent(roomId)}`;

  const load = useCallback(
    async (signal?: AbortSignal) => {
      let message: string = copy.reviewRefreshFailed;
      try {
        const response = await fetch(`${base}/review`, {
          cache: "no-store",
          signal,
        });
        const result = await response.json();
        if (signal?.aborted) return;
        if (!response.ok) {
          if (response.status === 401) setNeedsSignIn(true);
          if ([401, 403, 404, 409].includes(response.status)) {
            setUnavailable(true);
            setData(null);
          }
          message = result.error ?? copy.reviewRefreshFailed;
          throw new Error("review-refresh-failed");
        }
        setData(result);
        setRefreshError(null);
      } catch (error) {
        if (signal?.aborted) return;
        setRefreshError(message);
        throw error;
      }
    },
    [base],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal)
      .catch(() => {})
      .finally(() => {
        if (!controller.signal.aborted) setInitializing(false);
      });
    return () => controller.abort();
  }, [load]);
  useRoomPolling(!initializing && !pending && !unavailable, load);

  async function refresh() {
    setPending(true);
    try {
      await load();
    } catch {
      /* load provides the recovery message. */
    } finally {
      setPending(false);
    }
  }

  async function change(
    path: string,
    method: "POST" | "PATCH",
    body: object,
    success: string,
  ) {
    setPending(true);
    setActionError(null);
    setNotice("");
    try {
      const response = await fetch(`${base}/${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) {
        if (response.status === 401) setNeedsSignIn(true);
        setActionError(result.error ?? copy.reviewFailed);
      } else setNotice(result.changed ? success : copy.reviewUnchanged);
      // A saved command stays saved even if the subsequent refresh fails.
      await load().catch(() => {});
    } catch {
      setActionError(copy.reviewFailed);
    } finally {
      setPending(false);
    }
  }

  return (
    <section
      className="detail-panel host-review"
      aria-labelledby="review-title"
    >
      <div className="review-heading">
        <h2 id="review-title">{copy.reviewTitle}</h2>
        <button
          className="button button-secondary button-small"
          type="button"
          onClick={refresh}
          disabled={initializing || pending || unavailable}
        >
          {pending ? copy.refreshingEntry : copy.refreshEntry}
        </button>
      </div>
      <p className="field-hint">{copy.reviewHelp}</p>
      <p className="field-hint">{copy.approvalHelp}</p>
      {!unavailable && <p className="field-hint">{copy.reviewAutoRefresh}</p>}
      {refreshError && (
        <p className="error-message" role="alert">
          {refreshError}
        </p>
      )}
      {actionError && (
        <p className="error-message" role="alert">
          {actionError}
        </p>
      )}
      <p className="field-hint" role="status">
        {notice}
      </p>
      {!data && !refreshError && <p className="muted">{copy.reviewLoading}</p>}
      {needsSignIn && (
        <Link
          className="button button-secondary"
          href={`/sign-in?next=${encodeURIComponent(`/rooms/${roomId}`)}`}
        >
          {copy.signIn}
        </Link>
      )}
      {data && (
        <>
          <h3>{copy.pendingRequests}</h3>
          {data.requests.length === 0 ? (
            <p className="field-hint">{copy.noPendingRequests}</p>
          ) : (
            <ul className="review-list">
              {data.requests.map((entry) => (
                <li key={entry.id}>
                  <div>
                    <strong>{entry.name}</strong>
                    <p className="field-hint">
                      <time dateTime={entry.createdAt}>
                        {new Date(entry.createdAt).toLocaleString()}
                      </time>
                    </p>
                  </div>
                  <div className="review-actions">
                    <button
                      className="button button-small"
                      type="button"
                      disabled={pending}
                      aria-label={`Approve ${entry.name}`}
                      onClick={() =>
                        change(
                          `join-requests/${encodeURIComponent(entry.id)}/review`,
                          "POST",
                          { decision: "APPROVE" },
                          copy.reviewSaved,
                        )
                      }
                    >
                      {copy.approveRequest}
                    </button>
                    <button
                      className="button button-secondary button-small"
                      type="button"
                      disabled={pending}
                      aria-label={`Reject ${entry.name}`}
                      onClick={() =>
                        change(
                          `join-requests/${encodeURIComponent(entry.id)}/review`,
                          "POST",
                          { decision: "REJECT" },
                          copy.reviewSaved,
                        )
                      }
                    >
                      {copy.rejectRequest}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {data.hasMoreRequests && (
            <p className="field-hint">{copy.reviewMoreRequests}</p>
          )}
          <h3>{copy.membersAndRoles}</h3>
          <ul className="review-list">
            {data.members.map((entry) => (
              <li key={entry.userId}>
                <div>
                  <strong>{entry.name}</strong>
                  <p className="field-hint">
                    {memberRoleLabels[entry.role]} ·{" "}
                    {memberStatusLabels[entry.status]}
                  </p>
                </div>
                {entry.role !== "HOST" && (
                  <button
                    className="button button-secondary button-small"
                    type="button"
                    disabled={pending}
                    aria-label={`${entry.role === "MODERATOR" ? "Remove moderator role from" : "Make moderator:"} ${entry.name}`}
                    onClick={() =>
                      change(
                        `members/${encodeURIComponent(entry.userId)}/role`,
                        "PATCH",
                        {
                          role:
                            entry.role === "MODERATOR"
                              ? "PARTICIPANT"
                              : "MODERATOR",
                        },
                        copy.roleSaved,
                      )
                    }
                  >
                    {entry.role === "MODERATOR"
                      ? copy.removeModerator
                      : copy.makeModerator}
                  </button>
                )}
              </li>
            ))}
          </ul>
          {data.hasMoreMembers && (
            <p className="field-hint">{copy.reviewMoreMembers}</p>
          )}
        </>
      )}
    </section>
  );
}
