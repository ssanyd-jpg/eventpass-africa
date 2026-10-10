"use client";

import { useState, useTransition } from "react";
import { changePassword } from "./actions";

export default function PasswordSection() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    if (newPassword !== confirmPassword) {
      setError("New passwords don't match.");
      return;
    }
    startTransition(async () => {
      try {
        await changePassword({ currentPassword, newPassword });
        setCurrentPassword("");
        setNewPassword("");
        setConfirmPassword("");
        setSaved(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="card space-y-4 p-5">
      <div>
        <h2 className="mb-1 text-lg font-semibold">Password</h2>
        <p className="text-sm text-muted">Change the password you use to log in.</p>
      </div>
      <div>
        <label className="label" htmlFor="current-password">Current password</label>
        <input
          id="current-password"
          type="password"
          required
          autoComplete="current-password"
          className="input"
          value={currentPassword}
          onChange={(e) => {
            setCurrentPassword(e.target.value);
            setSaved(false);
          }}
        />
      </div>
      <div>
        <label className="label" htmlFor="new-password">New password</label>
        <input
          id="new-password"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          className="input"
          value={newPassword}
          onChange={(e) => {
            setNewPassword(e.target.value);
            setSaved(false);
          }}
        />
        <p className="mt-1 text-xs text-muted">At least 8 characters.</p>
      </div>
      <div>
        <label className="label" htmlFor="confirm-password">Confirm new password</label>
        <input
          id="confirm-password"
          type="password"
          required
          autoComplete="new-password"
          className="input"
          value={confirmPassword}
          onChange={(e) => {
            setConfirmPassword(e.target.value);
            setSaved(false);
          }}
        />
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      {saved && !error && <p className="text-sm text-ok">Password changed.</p>}
      <button type="submit" disabled={isPending} className="btn-primary disabled:opacity-50">
        {isPending ? "Changing…" : "Change password"}
      </button>
    </form>
  );
}
