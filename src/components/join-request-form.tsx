"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { copy, type EntryState } from "@/lib/content";
import { codeFromFragment } from "@/lib/invitation-input";
import { useRoomPolling } from "./use-room-polling";

export function JoinRequestForm({
  roomId,
  signedIn,
  initialState,
}: {
  roomId: string;
  signedIn: boolean;
  initialState: EntryState;
}) {
  const [code, setCode] = useState("");
  const [state, setState] = useState(initialState);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [storageNotice, setStorageNotice] = useState("");
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const storageKey = `learning-guide:invitation:${roomId}`;
  const returnTo = `/rooms/${encodeURIComponent(roomId)}/join`;

  useEffect(() => {
    const incoming = codeFromFragment(window.location.hash);
    let stored = false;
    try {
      if (incoming !== null) sessionStorage.setItem(storageKey, incoming);
      setCode(incoming ?? sessionStorage.getItem(storageKey) ?? "");
      stored = true;
    } catch {
      setCode(incoming ?? "");
      setStorageNotice(copy.invitationStorageFailed);
    }
    // Keep the invitation out of login return URLs. This also avoids leaving the
    // code in the address bar after capture; the original shared link still works.
    if (incoming !== null && stored)
      window.history.replaceState(
        window.history.state,
        "",
        window.location.pathname,
      );
  }, [storageKey]);

  function rememberInvitation() {
    try {
      sessionStorage.setItem(storageKey, code.trim());
    } catch {
      setStorageNotice(copy.invitationStorageFailed);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setExpiresAt(null);
    try {
      rememberInvitation();
      const endpoint = signedIn ? "join-requests" : "invitations/verify";
      const response = await fetch(
        `/api/rooms/${encodeURIComponent(roomId)}/${endpoint}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: code.trim() }),
        },
      );
      const result = await response.json();
      if (!response.ok) {
        if (response.status === 401) setNeedsSignIn(true);
        setError(result.error ?? copy.entryFailed);
        return;
      }
      if (signedIn) {
        setState(result.request.status);
        setCode("");
        try {
          sessionStorage.removeItem(storageKey);
        } catch {
          /* No server authority is stored here. */
        }
      } else setExpiresAt(result.expiresAt);
    } catch {
      setError(copy.entryFailed);
    } finally {
      setPending(false);
    }
  }

  async function loadStatus(signal?: AbortSignal) {
    try {
      const response = await fetch(
        `/api/rooms/${encodeURIComponent(roomId)}/join-requests`,
        { cache: "no-store", signal },
      );
      const result = await response.json();
      if (signal?.aborted) return;
      if (!response.ok) {
        if (response.status === 401) setNeedsSignIn(true);
        setError(result.error ?? copy.statusFailed);
        throw new Error(copy.statusFailed);
      }
      setState(result.state);
      setError(null);
    } catch (error) {
      if (signal?.aborted) return;
      if (!(error instanceof Error && error.message === copy.statusFailed))
        setError(copy.statusFailed);
      throw error;
    }
  }

  useRoomPolling(
    signedIn && state === "PENDING" && !pending && !needsSignIn,
    loadStatus,
  );

  async function refreshStatus() {
    setPending(true);
    try {
      await loadStatus();
    } catch {
      /* loadStatus owns the recovery message. */
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="stack-form">
      {state !== "NONE" ? (
        <>
          <p className="entry-status" role="status">
            {copy.entryStatus[state]}
          </p>
          {state === "PENDING" && (
            <p className="field-hint">{copy.reviewAutoRefresh}</p>
          )}
          {(state === "APPROVED" || state === "MEMBER") && (
            <Link
              className="button"
              href={`/rooms/${encodeURIComponent(roomId)}`}
            >
              {copy.viewRoom}
            </Link>
          )}
          {signedIn && (
            <button
              type="button"
              className="button button-secondary"
              disabled={pending}
              onClick={refreshStatus}
            >
              {pending ? copy.refreshingEntry : copy.refreshEntry}
            </button>
          )}
        </>
      ) : (
        <>
          <form className="stack-form" onSubmit={submit}>
            <div className="field">
              <label htmlFor="invitation-code">{copy.invitationCode}</label>
              <input
                id="invitation-code"
                value={code}
                onChange={(event) => {
                  setCode(event.target.value);
                  setExpiresAt(null);
                }}
                required
                minLength={43}
                maxLength={43}
                autoComplete="off"
                spellCheck={false}
                aria-describedby="invitation-code-help"
                disabled={pending}
              />
              <span id="invitation-code-help" className="field-hint">
                {copy.invitationCodeHelp}
              </span>
            </div>
            <button className="button" disabled={pending} type="submit">
              {pending
                ? signedIn
                  ? copy.requestingEntry
                  : copy.checkingInvitation
                : signedIn
                  ? copy.requestEntry
                  : copy.checkInvitation}
            </button>
          </form>
          {expiresAt && (
            <p className="field-hint" role="status">
              Invitation valid until{" "}
              <time dateTime={expiresAt}>
                {new Date(expiresAt).toLocaleString()}
              </time>
              . Sign in to request entry.
            </p>
          )}
        </>
      )}
      {((!signedIn && state === "NONE") || needsSignIn) && (
        <Link
          className="button button-secondary"
          prefetch={false}
          onClick={rememberInvitation}
          href={`/sign-in?next=${encodeURIComponent(returnTo)}`}
        >
          {copy.signInForEntry}
        </Link>
      )}
      {storageNotice && (
        <p className="field-hint" role="status">
          {storageNotice}
        </p>
      )}
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
