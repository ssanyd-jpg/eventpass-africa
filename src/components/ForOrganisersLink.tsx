"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useAppSession } from "@/lib/use-app-session";

// The homepage's "For organisers" CTAs all used to hardcode /login, which
// sends an already-logged-in organiser straight back to the login form —
// confusing, since nothing there tells them they're already signed in.
// Routes to the dashboard when a session exists, /login otherwise.
export default function ForOrganisersLink({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const { user } = useAppSession();
  return (
    <Link href={user ? "/dashboard" : "/login"} className={className}>
      {children}
    </Link>
  );
}
