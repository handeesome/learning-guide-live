"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { copy } from "@/lib/content";
import { invitationDurations, invitationPath } from "@/lib/invitation-input";

export function InvitationForm({ roomId }: { roomId: string }) {
  const [pending, setPending] = useState(false);
  const [invitation, setInvitation] = useState<{
    link: string;
    expiresAt: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [needsSignIn, setNeedsSignIn] = useState(false);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setNotice("");
    const input = new FormData(event.currentTarget);
    try {
      const response = await fetch(
        `/api/rooms/${encodeURIComponent(roomId)}/invitations`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            expiresInMinutes: Number(input.get("duration")),
          }),
        },
      );
      const result = await response.json();
      if (!response.ok) {
        if (response.status === 401) setNeedsSignIn(true);
        setError(result.error ?? copy.invitationFailed);
        return;
      }
      setInvitation({
        link: window.location.origin + invitationPath(roomId, result.code),
        expiresAt: result.expiresAt,
      });
    } catch {
      setError(copy.invitationFailed);
    } finally {
      setPending(false);
    }
  }

  async function copyLink() {
    if (!invitation) return;
    try {
      await navigator.clipboard.writeText(invitation.link);
      setNotice(copy.invitationCopied);
    } catch {
      setNotice(copy.invitationCopyFallback);
    }
  }

  return (
    <section className="invite-panel" aria-labelledby="invite-title">
      <h3 id="invite-title">{copy.inviteTitle}</h3>
      <p className="field-hint">{copy.inviteHelp}</p>
      <form className="stack-form" onSubmit={create}>
        <div className="field">
          <label htmlFor="invite-duration">{copy.inviteDuration}</label>
          <select
            id="invite-duration"
            name="duration"
            defaultValue="60"
            disabled={pending}
          >
            {invitationDurations.map((duration) => (
              <option key={duration.minutes} value={duration.minutes}>
                {duration.label}
              </option>
            ))}
          </select>
        </div>
        <button
          className="button button-secondary"
          disabled={pending}
          type="submit"
        >
          {pending ? copy.creatingInvitation : copy.createInvitation}
        </button>
      </form>
      {error && (
        <p role="alert" className="error-message">
          {error}
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
      {invitation && (
        <div className="stack-form invitation-result">
          <div className="field">
            <label htmlFor="invite-link">{copy.invitationLink}</label>
            <input
              id="invite-link"
              value={invitation.link}
              readOnly
              onFocus={(event) => event.currentTarget.select()}
              aria-describedby="invite-save-hint"
            />
            <span id="invite-save-hint" className="field-hint">
              {copy.invitationSaveHint}
            </span>
          </div>
          <p className="field-hint">
            Expires{" "}
            <time dateTime={invitation.expiresAt}>
              {new Date(invitation.expiresAt).toLocaleString()}
            </time>
          </p>
          <button
            className="button button-secondary"
            type="button"
            onClick={copyLink}
          >
            {copy.copyInvitation}
          </button>
          <p className="field-hint" role="status">
            {notice}
          </p>
        </div>
      )}
    </section>
  );
}
