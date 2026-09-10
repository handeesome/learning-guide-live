import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "./auth";

export async function currentSession() {
  return auth.api.getSession({ headers: await headers() });
}

export async function requireSession(returnTo = "/rooms") {
  const session = await currentSession();
  if (!session) redirect(`/sign-in?next=${encodeURIComponent(returnTo)}`);
  return session;
}
