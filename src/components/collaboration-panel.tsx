"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Room, RoomEvent } from "livekit-client";
import type { CollaborationSnapshot } from "@/lib/collaboration-input";
import { canRemoveCollaborationMember } from "@/lib/collaboration-input";
import { LatestRead, commitThenRefresh } from "@/lib/client-refresh";
import { useRoomPolling } from "./use-room-polling";

type Props = {
  roomId: string;
  room: Room;
  onSnapshot: (snapshot: CollaborationSnapshot | null) => void;
};

export function CollaborationPanel({ roomId, room, onSnapshot }: Props) {
  const [snapshot, setSnapshot] = useState<CollaborationSnapshot | null>(null);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [reads] = useState(() => new LatestRead());
  const base = `/api/rooms/${encodeURIComponent(roomId)}`;

  const load = useCallback(
    async (signal?: AbortSignal) => {
      await reads.run(
        async () => {
          const response = await fetch(`${base}/collaboration`, {
            cache: "no-store",
            signal: signal
              ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
              : AbortSignal.timeout(15_000),
          });
          const result = await response.json();
          return { response, result };
        },
        ({ response, result }) => {
          if (!response.ok) {
            if ([401, 403, 404].includes(response.status)) {
              setSnapshot(null);
              onSnapshot(null);
            }
            throw new Error(result.error ?? "Couldn't refresh room activity.");
          }
          setSnapshot(result);
          onSnapshot(result);
          setError(null);
        },
      );
    },
    [base, onSnapshot, reads],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).catch((reason) => {
      if (!controller.signal.aborted)
        setError(reason instanceof Error ? reason.message : "Refresh failed.");
    });
    const receive = (
      _payload: Uint8Array,
      _participant: unknown,
      _kind: unknown,
      topic?: string,
    ) => {
      if (topic === "learning-guide") void load().catch(() => {});
    };
    room.on(RoomEvent.DataReceived, receive);
    return () => {
      reads.invalidate();
      controller.abort();
      room.off(RoomEvent.DataReceived, receive);
      onSnapshot(null);
    };
  }, [load, onSnapshot, room, reads]);
  useRoomPolling(!pending, load);

  async function mutate(
    path: string,
    method: "POST" | "PATCH" | "DELETE",
    body: object,
    success: string,
  ) {
    setPending(true);
    setError(null);
    setNotice("");
    reads.invalidate();
    try {
      const { result, refreshFailed } = await commitThenRefresh(async () => {
        const response = await fetch(`${base}/${path}`, {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        });
        const result = await response.json();
        if (!response.ok)
          throw new Error(result.error ?? "The room action failed. Try again.");
        return result;
      }, load);
      setNotice(
        refreshFailed
          ? `${success} Couldn't refresh room activity. Use Refresh activity.`
          : result.broadcast === false
            ? `${success} Live update was delayed; clients will refresh.`
            : success,
      );
      return true;
    } catch (reason) {
      // A partial kick can already have changed SQL; expose its retry state.
      await load().catch(() => {});
      setError(
        reason instanceof Error
          ? reason.message
          : "The room action failed. Try again.",
      );
      return false;
    } finally {
      setPending(false);
    }
  }

  async function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = message.trim();
    if (!body) return;
    if (await mutate("messages", "POST", { body }, "Message saved."))
      setMessage("");
  }

  const self = snapshot?.members.find(
    (member) => member.userId === snapshot.selfUserId,
  );
  const canModerate =
    snapshot?.roomStatus === "OPEN" &&
    self?.status === "ACTIVE" &&
    (snapshot?.selfRole === "HOST" || snapshot?.selfRole === "MODERATOR");
  return (
    <div className="meeting-live-grid">
      <section className="meeting-chat" aria-labelledby="room-chat-title">
        <div className="meeting-section-heading">
          <h3 id="room-chat-title">Room chat</h3>
          <span>Saved to discussion history</span>
        </div>
        <ol className="meeting-chat-list" aria-live="polite">
          {snapshot?.messages.length ? (
            snapshot.messages.map((entry) => (
              <li key={entry.id}>
                <div>
                  <strong>{entry.name}</strong>
                  <time dateTime={entry.createdAt}>
                    {new Date(entry.createdAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                </div>
                <p>{entry.body}</p>
              </li>
            ))
          ) : (
            <li className="muted">No messages yet. Start with a question.</li>
          )}
        </ol>
        <form className="meeting-chat-form" onSubmit={submitMessage}>
          <label htmlFor={`chat-${roomId}`}>Message</label>
          <textarea
            id={`chat-${roomId}`}
            value={message}
            maxLength={2000}
            rows={3}
            disabled={pending || self?.status !== "ACTIVE"}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="Add a thought or question"
          />
          <div>
            <span>{message.length}/2000</span>
            <button
              className="button button-small"
              type="submit"
              disabled={pending || !message.trim() || self?.status !== "ACTIVE"}
            >
              Send message
            </button>
          </div>
        </form>
      </section>
      <section className="meeting-people" aria-labelledby="room-people-title">
        <div className="meeting-section-heading">
          <h3 id="room-people-title">People</h3>
          <span>{snapshot?.selfRole ?? "Loading"}</span>
        </div>
        <ul className="meeting-people-list">
          {snapshot?.members.map((member) => {
            const isSelf = member.userId === snapshot.selfUserId;
            const isFocused = member.userId === snapshot.focusedUserId;
            const canKick = canRemoveCollaborationMember(snapshot, member);
            return (
              <li key={member.userId}>
                <div>
                  <strong>
                    {member.name}
                    {isSelf ? " (you)" : ""}
                  </strong>
                  <span>
                    {member.role} · {member.status}
                  </span>
                </div>
                <div className="meeting-person-state">
                  {member.handRaised && <span>Hand raised</span>}
                  {isFocused && <span>Focused</span>}
                  {member.mediaRemovalPending && (
                    <span>Media removal pending</span>
                  )}
                </div>
                <div className="meeting-person-actions">
                  {isSelf && member.status === "ACTIVE" && (
                    <button
                      className="button button-secondary button-small"
                      type="button"
                      disabled={pending}
                      onClick={() =>
                        void mutate(
                          "hand",
                          "PATCH",
                          { raised: !member.handRaised },
                          member.handRaised ? "Hand lowered." : "Hand raised.",
                        )
                      }
                    >
                      {member.handRaised ? "Lower hand" : "Raise hand"}
                    </button>
                  )}
                  {canModerate && member.status === "ACTIVE" && (
                    <button
                      className="button button-secondary button-small"
                      type="button"
                      disabled={pending}
                      onClick={() =>
                        void mutate(
                          "focus",
                          "PATCH",
                          { targetUserId: isFocused ? null : member.userId },
                          isFocused ? "Focus cleared." : "Focus updated.",
                        )
                      }
                    >
                      {isFocused ? "Clear focus" : "Focus"}
                    </button>
                  )}
                  {canModerate && !isSelf && member.handRaised && (
                    <button
                      className="button button-secondary button-small"
                      type="button"
                      disabled={pending}
                      onClick={() =>
                        void mutate(
                          "hand",
                          "PATCH",
                          { raised: false, targetUserId: member.userId },
                          "Hand lowered.",
                        )
                      }
                    >
                      Lower hand
                    </button>
                  )}
                  {canKick && (
                    <button
                      className="button button-secondary button-small"
                      type="button"
                      disabled={pending}
                      onClick={() =>
                        void mutate(
                          `members/${encodeURIComponent(member.userId)}/role`,
                          "DELETE",
                          {},
                          "Participant removed.",
                        )
                      }
                    >
                      {member.mediaRemovalPending ? "Retry removal" : "Remove"}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        <button
          className="button button-secondary button-small"
          type="button"
          disabled={pending}
          onClick={() =>
            void load().catch(() =>
              setError("Couldn't refresh room activity. Try again."),
            )
          }
        >
          Refresh activity
        </button>
        {notice && (
          <p className="field-hint" role="status">
            {notice}
          </p>
        )}
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
      </section>
    </div>
  );
}
