import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { currentSession } from "@/lib/session";
import { safeReturnPath } from "@/lib/content";

export const metadata = { title: "Create account" };
export default async function SignUp({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const returnTo = safeReturnPath((await searchParams).next);
  if (await currentSession()) redirect(returnTo);
  return (
    <main id="main" className="auth-main">
      <AuthForm mode="sign-up" returnTo={returnTo} />
    </main>
  );
}
