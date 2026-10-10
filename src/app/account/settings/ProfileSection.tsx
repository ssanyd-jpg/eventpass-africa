"use client";

import { useState, useTransition } from "react";
import { updateProfile } from "./actions";

export default function ProfileSection({ initialName, initialPhone }: { initialName: string; initialPhone: string }) {
  const [name, setName] = useState(initialName);
  const [phone, setPhone] = useState(initialPhone);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    startTransition(async () => {
      try {
        await updateProfile({ name, phone });
        setSaved(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="card space-y-4 p-5">
      <div>
        <h2 className="mb-1 text-lg font-semibold">Profile</h2>
        <p className="text-sm text-muted">Your name and phone number, as organizers and vendors see them.</p>
      </div>
      <div>
        <label className="label" htmlFor="profile-name">Full name</label>
        <input
          id="profile-name"
          required
          className="input"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setSaved(false);
          }}
        />
      </div>
      <div>
        <label className="label" htmlFor="profile-phone">Phone number</label>
        <input
          id="profile-phone"
          className="input"
          placeholder="+255 7XX XXX XXX"
          value={phone}
          onChange={(e) => {
            setPhone(e.target.value);
            setSaved(false);
          }}
        />
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      {saved && !error && <p className="text-sm text-ok">Saved.</p>}
      <button type="submit" disabled={isPending} className="btn-primary disabled:opacity-50">
        {isPending ? "Saving…" : "Save changes"}
      </button>
    </form>
  );
}
