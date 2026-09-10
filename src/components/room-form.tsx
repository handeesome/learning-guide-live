"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { copy, topics } from "@/lib/content";

export function RoomForm() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.fromEntries(form)),
      });
      const result = await response.json();
      if (!response.ok) {
        setError(result.error ?? copy.roomSaveError);
        return;
      }
      router.push(`/rooms/${result.id}`);
      router.refresh();
    } catch {
      setError(copy.connectionError);
    } finally {
      setPending(false);
    }
  }
  return (
    <form className="stack-form" onSubmit={submit}>
      <div className="field">
        <label htmlFor="topic">Learning topic</label>
        <select id="topic" name="topic" required defaultValue="">
          <option value="" disabled>
            Choose a topic
          </option>
          {topics.map((topic) => (
            <option value={topic.id} key={topic.id}>
              {topic.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="title">Room title</label>
        <input
          id="title"
          name="title"
          required
          minLength={4}
          maxLength={120}
          placeholder="What would you like to discuss?"
        />
      </div>
      <div className="field">
        <label htmlFor="description">Description</label>
        <textarea
          id="description"
          name="description"
          rows={4}
          required
          minLength={10}
          maxLength={1000}
          aria-describedby="description-hint"
        />
        <span className="field-hint" id="description-hint">
          Give participants a starting question or a little context.
        </span>
      </div>
      <p className="note">
        Rooms hold up to 8 participants. You approve who joins.
      </p>
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button type="submit" className="button" disabled={pending}>
          {pending ? "Creating room…" : copy.newRoom}
        </button>
        <Link href="/rooms" className="text-button">
          Cancel
        </Link>
      </div>
    </form>
  );
}
