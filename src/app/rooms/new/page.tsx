import Link from "next/link";
import { RoomForm } from "@/components/room-form";
import { requireSession } from "@/lib/session";

export const metadata = { title: "Create room" };
export default async function NewRoom() {
  await requireSession("/rooms/new");
  return (
    <main id="main" className="page-shell narrow-shell">
      <Link href="/rooms" className="back-link">
        ← Discussion rooms
      </Link>
      <div className="page-heading">
        <div>
          <h1>Create a room</h1>
          <p className="muted">
            Start with a question worth exploring together.
          </p>
        </div>
      </div>
      <div className="form-panel">
        <RoomForm />
      </div>
    </main>
  );
}
