import Link from "next/link";
import { copy } from "@/lib/content";
export default function NotFound() {
  return (
    <main id="main" className="page-shell empty-state">
      <h1>{copy.roomUnavailable}</h1>
      <p>{copy.roomUnavailableHelp}</p>
      <Link className="button" href="/rooms">
        Discussion rooms
      </Link>
    </main>
  );
}
