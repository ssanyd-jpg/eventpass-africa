"use client";

import { useState, type InputHTMLAttributes } from "react";
import { useTranslation } from "@/lib/use-translation";

// Every password field in the app (login, register, settings, reset-
// password, ticket-transfer claim) wants the same show/hide toggle — one
// component instead of duplicating the eye icon and local state five times.
// Takes the same props as a plain <input type="password">, minus `type`
// itself (always "password" until toggled).
export default function PasswordInput({
  className,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  const [visible, setVisible] = useState(false);
  const { t } = useTranslation();

  return (
    <div className="relative">
      <input {...props} type={visible ? "text" : "password"} className={`${className ?? "input"} pr-10`} />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={t(visible ? "password.hide" : "password.show")}
        aria-pressed={visible}
        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted transition hover:text-foreground"
      >
        {visible ? <EyeOffIcon /> : <EyeIcon />}
      </button>
    </div>
  );
}

function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
      <path d="M3 3l18 18" />
      <path d="M10.6 5.2A10.8 10.8 0 0 1 12 5c6.5 0 10 7 10 7a15.6 15.6 0 0 1-4.1 4.6M6.2 6.2C3.6 7.9 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 4.4-1" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </svg>
  );
}
