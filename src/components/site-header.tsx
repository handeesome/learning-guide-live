import Link from "next/link";
import { currentSession } from "@/lib/session";
import { copy, initials } from "@/lib/content";
import { SignOut } from "./sign-out";

export async function SiteHeader() {
  const session = await currentSession();
  return (
    <header className="site-header">
      <div className="header-inner">
        <Link href="/rooms" className="brand">
          <span className="brand-mark" aria-hidden="true">
            lg
          </span>
          {copy.brand}
        </Link>
        <nav className="header-nav" aria-label="Main navigation">
          <Link href="/rooms">Rooms</Link>
        </nav>
        <div className="header-account">
          {session ? (
            <>
              <span className="avatar" aria-hidden="true">
                {initials(session.user.name)}
              </span>
              <span className="account-name">{session.user.name}</span>
              <SignOut />
            </>
          ) : (
            <Link
              href="/sign-in"
              className="button button-small button-secondary"
            >
              {copy.signIn}
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
