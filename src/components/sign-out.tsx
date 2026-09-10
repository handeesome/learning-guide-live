"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { copy } from "@/lib/content";

export function SignOut() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  async function signOut() {
    setPending(true);
    setError(false);
    try {
      const result = await authClient.signOut();
      if (result.error) throw new Error("Sign-out failed");
      router.push("/sign-in");
      router.refresh();
    } catch {
      setError(true);
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="sign-out">
      <button className="text-button" onClick={signOut} disabled={pending}>
        {pending ? "Signing out…" : copy.signOut}
      </button>
      {error && (
        <span className="inline-error" role="alert">
          Couldn't sign out. Try again.
        </span>
      )}
    </div>
  );
}
