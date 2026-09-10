import Link from "next/link";
import { db } from "@/lib/db";
import { copy, initials, topicLabel, topics } from "@/lib/content";

export default async function Rooms({
  searchParams,
}: {
  searchParams: Promise<{ topic?: string; view?: string }>;
}) {
  const params = await searchParams;
  const selectedTopic = topics.find((topic) => topic.id === params.topic);
  const past = params.view === "past";
  const rooms = await db.room.findMany({
    where: {
      status: past ? "ENDED" : { not: "ENDED" },
      ...(selectedTopic ? { topic: selectedTopic.id } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      title: true,
      description: true,
      topic: true,
      status: true,
      host: { select: { name: true } },
      _count: { select: { members: true } },
    },
  });
  function filterUrl(topic?: string, view = past ? "past" : "open") {
    const query = new URLSearchParams();
    if (topic) query.set("topic", topic);
    if (view === "past") query.set("view", "past");
    return `/rooms${query.size ? `?${query}` : ""}`;
  }
  return (
    <main id="main" className="page-shell">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Learn together</p>
          <h1>{copy.rooms}</h1>
          <p className="muted">Choose a topic. Bring a question.</p>
        </div>
        <Link className="button" href="/rooms/new">
          <span aria-hidden="true">＋</span>
          {copy.newRoom}
        </Link>
      </div>
      <nav className="view-tabs" aria-label="Room status">
        <Link
          className={!past ? "active" : ""}
          href={filterUrl(selectedTopic?.id, "open")}
          aria-current={!past ? "page" : undefined}
        >
          Open rooms
        </Link>
        <Link
          className={past ? "active" : ""}
          href={filterUrl(selectedTopic?.id, "past")}
          aria-current={past ? "page" : undefined}
        >
          Past discussions
        </Link>
      </nav>
      <div className="list-tools">
        <nav className="topic-filters" aria-label="Learning topics">
          <Link
            href={filterUrl()}
            className={!selectedTopic ? "selected" : ""}
            aria-current={!selectedTopic ? "page" : undefined}
          >
            All topics
          </Link>
          {topics.map((topic) => (
            <Link
              key={topic.id}
              href={filterUrl(topic.id)}
              className={selectedTopic?.id === topic.id ? "selected" : ""}
              aria-current={selectedTopic?.id === topic.id ? "page" : undefined}
            >
              {topic.label}
            </Link>
          ))}
        </nav>
        <span className="result-count">
          {rooms.length} {rooms.length === 1 ? "room" : "rooms"}
        </span>
      </div>
      <section
        className="room-list"
        aria-label={past ? "Past discussions" : "Open discussion rooms"}
      >
        {rooms.length ? (
          rooms.map((room) => (
            <article className="room-row" key={room.id}>
              <div className="room-row-main">
                <p className="topic-label">{topicLabel(room.topic)}</p>
                <h2>
                  <Link href={`/rooms/${room.id}`}>{room.title}</Link>
                </h2>
                <p className="room-description">{room.description}</p>
                <div className="room-meta">
                  <span className="avatar avatar-small" aria-hidden="true">
                    {initials(room.host.name)}
                  </span>
                  <span>Hosted by {room.host.name}</span>
                  <span className="meta-divider" aria-hidden="true">
                    ·
                  </span>
                  <span>
                    {past
                      ? `${room._count.members} members`
                      : "Up to 8 participants"}
                  </span>
                </div>
              </div>
              <div className="room-row-action">
                <span className="status-badge">
                  {room.status === "ENDED"
                    ? "Ended"
                    : room.status === "ENDING"
                      ? "Ending"
                      : "Open"}
                </span>
                <Link className="room-link" href={`/rooms/${room.id}`}>
                  View room <span aria-hidden="true">↗</span>
                </Link>
              </div>
            </article>
          ))
        ) : (
          <div className="empty-state">
            <h2>{copy.emptyRooms}</h2>
            <p>
              {past
                ? "Past discussions will appear here when rooms end."
                : copy.emptyRoomsHelp}
            </p>
            <Link className="button button-secondary" href="/rooms/new">
              {copy.newRoom}
            </Link>
          </div>
        )}
      </section>
      <p className="list-note">Small groups. Entry approved by the host.</p>
    </main>
  );
}
