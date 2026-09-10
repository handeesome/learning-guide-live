"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth-client";
import { copy } from "@/lib/content";

export function AuthForm({
  mode,
  returnTo,
}: {
  mode: "sign-in" | "sign-up";
  returnTo: string;
}) {
  const registering = mode === "sign-up";
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const data = new FormData(event.currentTarget);
    const credentials = {
      email: String(data.get("email")).trim(),
      password: String(data.get("password")),
    };
    try {
      const result = registering
        ? await authClient.signUp.email({
            ...credentials,
            name: String(data.get("name")).trim(),
          })
        : await authClient.signIn.email(credentials);
      if (result.error) {
        setError(
          result.error.status === 429
            ? copy.throttled
            : registering
              ? copy.signUpError
              : copy.badCredentials,
        );
        return;
      }
      router.push(returnTo);
      router.refresh();
    } catch {
      setError(copy.connectionError);
    } finally {
      setPending(false);
    }
  }

  const alternative = registering ? "/sign-in" : "/sign-up";
  return (
    <div className="auth-panel">
      <p className="eyebrow">Learning Guide Live</p>
      <h1>{registering ? copy.signUpTitle : copy.signInTitle}</h1>
      <p className="muted auth-description">
        {registering ? copy.signUpHelp : copy.signInHelp}
      </p>
      <form
        onSubmit={submit}
        className="stack-form"
        aria-describedby={error ? "auth-error" : undefined}
      >
        {registering && (
          <div className="field">
            <label htmlFor="name">{copy.displayName}</label>
            <input
              id="name"
              name="name"
              autoComplete="name"
              required
              minLength={1}
              maxLength={60}
              autoFocus
            />
          </div>
        )}
        <div className="field">
          <label htmlFor="email">{copy.email}</label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            maxLength={254}
            autoFocus={!registering}
          />
        </div>
        <div className="field">
          <label htmlFor="password">{copy.password}</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete={registering ? "new-password" : "current-password"}
            required
            minLength={registering ? 10 : 1}
            maxLength={128}
            aria-describedby={registering ? "password-hint" : undefined}
          />
          {registering && (
            <span id="password-hint" className="field-hint">
              {copy.passwordHint}
            </span>
          )}
        </div>
        {error && (
          <p id="auth-error" className="error-message" role="alert">
            {error}
          </p>
        )}
        <button className="button" type="submit" disabled={pending}>
          {pending
            ? registering
              ? "Creating account…"
              : "Signing in…"
            : registering
              ? copy.signUp
              : copy.signIn}
        </button>
      </form>
      <p className="auth-alternative">
        {registering
          ? "Already have an account?"
          : "New to Learning Guide Live?"}{" "}
        <Link href={`${alternative}?next=${encodeURIComponent(returnTo)}`}>
          {registering ? copy.signIn : copy.signUp}
        </Link>
      </p>
    </div>
  );
}
