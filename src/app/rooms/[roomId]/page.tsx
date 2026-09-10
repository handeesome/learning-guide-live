import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { currentSession } from "@/lib/session";
import { initials, topicLabel, roomStatusLabels } from "@/lib/content";
import { loadRoomAccess } from "@/lib/room-access";
import { canReadRoomHistory, canPerformRoomAction } from "@/lib/room-policy";
import { InvitationForm } from "@/components/invitation-form";
import { HostReviewPanel } from "@/components/host-review-panel";
import { MeetingPanel } from "@/components/meeting-panel";
import { RoomEndPanel } from "@/components/room-end-panel";
import { SummaryPanel } from "@/components/summary-panel";

export default async function RoomDetail({
  params,
}: {
  params: Promise<{ roomId: string }>;
}) {
  const { roomId } = await params;
  const session = await currentSession();
  const access = await loadRoomAccess(roomId, session?.user.id ?? null);
  if (!access) notFound();
  const { room } = access;
  const canReadHistory = canReadRoomHistory(access.policy);
  const canReview = canPerformRoomAction(access.policy, {
    action: "review_requests",
  });
  const canEnd = canPerformRoomAction(access.policy, { action: "end_room" });
  const canGenerateSummary = canPerformRoomAction(access.policy, {
    action: "generate_summary",
  });
  const messages = canReadHistory
    ? await db.chatMessage.findMany({
        where: { roomId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 30,
        include: { user: { select: { name: true } } },
      })
    : [];
  const members =
    canReadHistory && !canReview
      ? await db.roomMember.findMany({
          where: { roomId },
          include: { user: { select: { name: true } } },
          orderBy: { createdAt: "asc" },
        })
      : [];
  return (
    <main id="main" className="page-shell">
      <Link href="/rooms" className="back-link">
        ← Discussion rooms
      </Link>
      <div className="detail-heading">
        <p className="topic-label">{topicLabel(room.topic)}</p>
        <h1>{room.title}</h1>
        <p className="detail-description">{room.description}</p>
        <div className="room-meta">
          <span className="avatar avatar-small" aria-hidden="true">
            {initials(room.host.name)}
          </span>
          <span>Hosted by {room.host.name}</span>
          <span className="meta-divider" aria-hidden="true">
            ·
          </span>
          <span className="status-badge">{roomStatusLabels[room.status]}</span>
        </div>
      </div>
      <div className="detail-grid">
        <div className="room-main-column">
          {canReadHistory && room.status === "OPEN" && (
            <MeetingPanel key={`meeting:${roomId}`} roomId={roomId} />
          )}
          {canEnd && <RoomEndPanel roomId={roomId} status={room.status} />}
          {canReadHistory && room.status === "ENDED" && (
            <SummaryPanel roomId={roomId} canGenerate={canGenerateSummary} />
          )}
          {canReview && <HostReviewPanel key={roomId} roomId={roomId} />}
          <section className="detail-panel">
            <h2>Discussion history</h2>
            {canReadHistory ? (
              messages.length ? (
                <ol className="message-history">
                  {messages.toReversed().map((message) => (
                    <li key={message.id}>
                      <div className="message-heading">
                        <strong>{message.user.name}</strong>
                        <time dateTime={message.createdAt.toISOString()}>
                          {message.createdAt.toISOString().slice(11, 16)} UTC
                        </time>
                      </div>
                      <p>{message.body}</p>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="muted">No messages yet.</p>
              )
            ) : (
              <div className="history-restricted">
                <p className="muted">
                  Discussion history is available to room members.
                </p>
                {!session && (
                  <Link
                    className="button button-secondary"
                    href={`/sign-in?next=${encodeURIComponent(`/rooms/${roomId}`)}`}
                  >
                    Sign in
                  </Link>
                )}
              </div>
            )}
          </section>
        </div>
        <aside className="detail-panel">
          <h2>Room details</h2>
          <dl className="room-facts">
            <div>
              <dt>Group size</dt>
              <dd>Up to 8 participants</dd>
            </div>
            <div>
              <dt>Entry</dt>
              <dd>Host approval</dd>
            </div>
            <div>
              <dt>Created</dt>
              <dd>{room.createdAt.toISOString().slice(0, 10)}</dd>
            </div>
          </dl>
          {canPerformRoomAction(access.policy, {
            action: "create_invitation",
          }) ? (
            <InvitationForm roomId={roomId} />
          ) : (
            <div className="room-entry">
              <Link
                className="button button-secondary"
                href={`/rooms/${encodeURIComponent(roomId)}/join`}
              >
                View entry request
              </Link>
            </div>
          )}
          {canReadHistory && !canReview && (
            <>
              <h3>Members</h3>
              <ul className="member-list">
                {members.map((entry) => (
                  <li key={entry.id}>
                    <span className="avatar avatar-small" aria-hidden="true">
                      {initials(entry.user.name)}
                    </span>
                    <span>{entry.user.name}</span>
                    <span className="member-role">
                      {entry.role === "HOST"
                        ? "Host"
                        : entry.role === "MODERATOR"
                          ? "Moderator"
                          : "Member"}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </aside>
      </div>
    </main>
  );
}
