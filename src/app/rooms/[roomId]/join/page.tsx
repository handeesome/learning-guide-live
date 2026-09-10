import Link from "next/link";
import { notFound } from "next/navigation";
import { currentSession } from "@/lib/session";
import { loadRoomAccess } from "@/lib/room-access";
import { ownJoinStatus } from "@/lib/invitations";
import { JoinRequestForm } from "@/components/join-request-form";
import { copy, topicLabel, type EntryState } from "@/lib/content";

export const metadata = {
  title: "Request room entry",
  robots: { index: false, follow: false },
};

export default async function JoinRoom({
  params,
}: {
  params: Promise<{ roomId: string }>;
}) {
  const { roomId } = await params;
  const session = await currentSession();
  const access = await loadRoomAccess(roomId, session?.user.id ?? null);
  if (!access) notFound();
  const state: EntryState = session
    ? (await ownJoinStatus(roomId, session.user.id)).state
    : access.room.status === "OPEN"
      ? "NONE"
      : "CLOSED";
  return (
    <main id="main" className="page-shell narrow-shell">
      <Link className="back-link" href={`/rooms/${encodeURIComponent(roomId)}`}>
        ← Room details
      </Link>
      <div className="page-heading">
        <div>
          <p className="topic-label">{topicLabel(access.room.topic)}</p>
          <h1>{copy.entryTitle}</h1>
          <p className="muted">{access.room.title}</p>
        </div>
      </div>
      <section className="form-panel stack-form" aria-label={copy.entryTitle}>
        <p className="muted">{copy.entryHelp}</p>
        <JoinRequestForm
          roomId={roomId}
          signedIn={Boolean(session)}
          initialState={state}
        />
      </section>
    </main>
  );
}
