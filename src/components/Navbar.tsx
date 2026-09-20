"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import { useAppSession } from "@/lib/use-app-session";

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const isAnchor = href.startsWith("#");
  const active = !isAnchor && (pathname === href || (href !== "/" && pathname.startsWith(href)));
  return (
    <Link
      href={href}
      className={[
        "relative text-[11px] font-semibold uppercase tracking-[0.13em] transition after:absolute after:-bottom-5 after:left-0 after:h-0.5 after:w-0 after:rounded-full after:bg-[#f6bf22] after:transition-all hover:text-white",
        active ? "text-white after:w-full" : "text-white/60",
      ].join(" ")}
    >
      {children}
    </Link>
  );
}

export default function Navbar() {
  const { user } = useAppSession();
  const pathname = usePathname();

  if (pathname?.startsWith("/vendor")) return null;
  if (pathname === "/") return null;

  return (
    <header className="sticky top-0 z-50 border-b border-white/10 bg-[#03070c]/90 backdrop-blur-xl">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-5 px-5 py-3 sm:px-8">
        <Link href="/" className="chaap-brand shrink-0">
          <img src="/chaap-reference-logo.webp" alt="CHAAP Africa" />
        </Link>

        <nav className="hidden items-center gap-8 lg:flex">
          <NavLink href="/">HOME</NavLink>
          <NavLink href="/events">EVENTS</NavLink>
          <NavLink href="#organisers">ORGANISERS</NavLink>
          <NavLink href="#attendees">ATTENDEES</NavLink>
          <NavLink href="#solutions">SOLUTIONS</NavLink>
          <NavLink href="#about">ABOUT</NavLink>
        </nav>

        <div className="flex items-center gap-2.5">
          <Link href="/events" aria-label="Search events" className="hidden h-10 w-10 items-center justify-center rounded-full text-white/75 transition hover:bg-white/5 hover:text-white sm:flex">
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
          </Link>

          {user ? (
            <div className="flex items-center gap-2">
              <Link href="/dashboard" className="hidden rounded-lg border border-[#16b9ff]/60 px-4 py-2.5 text-xs font-bold uppercase tracking-[0.1em] text-white transition hover:bg-[#16b9ff]/10 sm:inline-flex">
                DASHBOARD
              </Link>
              <button
                onClick={() => signOut({ callbackUrl: "/" })}
                className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2.5 text-xs font-bold uppercase tracking-[0.1em] text-white/70 transition hover:text-white"
              >
                SIGN OUT
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Link href="/login" className="hidden rounded-lg border border-[#16b9ff]/60 px-5 py-2.5 text-xs font-bold uppercase tracking-[0.1em] text-white transition hover:bg-[#16b9ff]/10 sm:inline-flex">
                LOGIN
              </Link>
              <Link href="/register" className="rounded-lg px-5 py-2.5 text-xs font-bold uppercase tracking-[0.1em] text-black shadow-[0_0_22px_rgba(246,191,34,.25)]" style={{ background: "linear-gradient(135deg,#ffd740,#e9a800)" }}>
                CREATE EVENT
              </Link>
            </div>
          )}
        </div>
      </div>

      <div className="flex gap-6 overflow-x-auto border-t border-white/5 px-5 py-2.5 lg:hidden sm:px-8">
        <Link href="/events" className="shrink-0 text-[10px] font-bold uppercase tracking-[0.16em] text-white/65">EVENTS</Link>
        <Link href="#organisers" className="shrink-0 text-[10px] font-bold uppercase tracking-[0.16em] text-white/65">ORGANISERS</Link>
        <Link href="#attendees" className="shrink-0 text-[10px] font-bold uppercase tracking-[0.16em] text-white/65">ATTENDEES</Link>
        <Link href="#solutions" className="shrink-0 text-[10px] font-bold uppercase tracking-[0.16em] text-white/65">SOLUTIONS</Link>
        <Link href="#about" className="shrink-0 text-[10px] font-bold uppercase tracking-[0.16em] text-white/65">ABOUT</Link>
        {user && <Link href="/dashboard" className="shrink-0 text-[10px] font-bold uppercase tracking-[0.16em] text-[#16b9ff]">DASHBOARD</Link>}
      </div>
    </header>
  );
}
