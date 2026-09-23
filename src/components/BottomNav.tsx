"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { useAppSession } from "@/lib/use-app-session";
import { useTranslation } from "@/lib/use-translation";
import { useSwipeDismiss } from "@/lib/use-swipe-gesture";

// Session E — staff/organiser/auth surfaces keep the top Navbar only; this
// bar is for the attendee-facing browsing/ticket/wallet flow specifically
// (spec item 2), so it's an exclusion list against the handful of route
// families that are NOT that, rather than an inclusion list that would need
// updating every time a new attendee page is added.
const HIDDEN_PREFIXES = [
  "/dashboard",
  "/scan",
  "/vendor",
  "/sponsor",
  "/admin",
  "/login",
  "/register",
  "/forgot-password",
  "/reset-password",
  "/team/accept",
];

const NAV_HEIGHT_PX = 64;

function isHidden(pathname: string) {
  return HIDDEN_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export default function BottomNav() {
  const pathname = usePathname();
  const { user } = useAppSession();
  const { t } = useTranslation();
  const [sheetOpen, setSheetOpen] = useState(false);

  useEffect(() => {
    setSheetOpen(false);
  }, [pathname]);

  if (!pathname || isHidden(pathname)) return null;

  return (
    <>
      {/* Reserves scroll space at the end of the page's own content, right
          before the fixed bar below — cheaper and more robust than auditing
          every attendee page's own bottom padding to make sure it clears a
          64px fixed bar. */}
      <div style={{ height: NAV_HEIGHT_PX }} className="md:hidden" aria-hidden="true" />
      <nav
        className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-4 border-t border-border bg-surface/95 backdrop-blur md:hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        aria-label={t("nav.browse")}
      >
        <BottomNavLink href="/events" icon="🔍" label={t("nav.browse")} active={pathname === "/events" || pathname === "/"} />
        <BottomNavLink href="/account/tickets" icon="🎫" label={t("nav.myTickets")} active={pathname.startsWith("/account/tickets")} />
        <BottomNavLink href="/account/wallet" icon="👛" label={t("nav.myWallets")} active={pathname.startsWith("/account/wallet")} />
        {user ? (
          <button
            type="button"
            onClick={() => setSheetOpen(true)}
            className={`flex min-h-12 flex-col items-center justify-center gap-0.5 py-2 text-xs font-medium transition ${
              sheetOpen ? "text-foreground" : "text-muted hover:text-foreground"
            }`}
          >
            <span aria-hidden="true" className="text-lg leading-none">👤</span>
            {t("nav.account")}
          </button>
        ) : (
          <BottomNavLink href="/login" icon="👤" label={t("nav.account")} active={false} />
        )}
      </nav>
      {user && sheetOpen && <AccountSheet onClose={() => setSheetOpen(false)} />}
    </>
  );
}

function BottomNavLink({ href, icon, label, active }: { href: string; icon: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      className={`flex min-h-12 flex-col items-center justify-center gap-0.5 py-2 text-xs font-medium transition ${
        active ? "text-accent-hover" : "text-muted hover:text-foreground"
      }`}
    >
      <span aria-hidden="true" className="text-lg leading-none">{icon}</span>
      {label}
    </Link>
  );
}

// A bottom sheet, not a top-anchored dropdown (the Navbar's own mobile
// "Account" menu uses that instead) — matches where it's triggered from,
// and swipes down to dismiss like any native sheet.
function AccountSheet({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const { user } = useAppSession();
  const { t } = useTranslation();
  const sheetRef = useSwipeDismiss<HTMLDivElement>(onClose);

  if (!user) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end md:hidden">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} aria-hidden="true" />
      <div
        ref={sheetRef}
        role="dialog"
        aria-label={t("nav.account")}
        className="relative w-full rounded-t-2xl border-t border-border bg-surface p-2 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] shadow-lg shadow-black/40"
      >
        <div className="mx-auto mb-2 mt-1 h-1.5 w-10 rounded-full bg-surface2" aria-hidden="true" />
        <SheetLink href="/account/tickets" onClick={onClose}>{t("nav.myTickets")}</SheetLink>
        <SheetLink href="/account/vendor-applications" onClick={onClose}>{t("nav.myVendorApps")}</SheetLink>
        <SheetLink href="/account/wallet" onClick={onClose}>{t("nav.myWallets")}</SheetLink>
        <SheetLink href="/account/groups" onClick={onClose}>{t("nav.myGroups")}</SheetLink>
        <SheetLink href="/account/sessions" onClick={onClose}>{t("nav.sessions")}</SheetLink>
        <SheetLink href="/account/loyalty" onClick={onClose}>{t("nav.myStatus")}</SheetLink>
        <SheetLink href="/account/rewards" onClick={onClose}>{t("nav.myRewards")}</SheetLink>
        <SheetLink href="/account/support" onClick={onClose}>{t("nav.support")}</SheetLink>
        {user.organizationRole && (
          <>
            <div className="my-1.5 border-t border-border" />
            <SheetLink href="/dashboard" onClick={onClose}>{t("nav.dashboard")}</SheetLink>
          </>
        )}
        <div className="my-1.5 border-t border-border" />
        <button
          type="button"
          className="flex min-h-12 w-full items-center rounded-lg px-3 text-left text-base font-medium text-danger hover:bg-surface2"
          onClick={() => {
            onClose();
            signOut({ redirect: false });
            router.push("/");
          }}
        >
          {t("nav.signOut")}
        </button>
      </div>
    </div>
  );
}

function SheetLink({ href, onClick, children }: { href: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      onClick={onClick}
      className="flex min-h-12 items-center rounded-lg px-3 text-base font-medium text-foreground hover:bg-surface2"
    >
      {children}
    </Link>
  );
}
