"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { useAppSession } from "@/lib/use-app-session";
import { useTranslation } from "@/lib/use-translation";
import SyncStatusBadge from "@/components/SyncStatusBadge";

function NavLink({
  href,
  children,
  className = "",
  onClick,
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
  onClick?: () => void;
}) {
  const pathname = usePathname();
  const active = pathname === href || (href !== "/" && pathname.startsWith(href));
  return (
    <Link
      href={href}
      onClick={onClick}
      className={`text-sm font-medium transition ${
        active ? "text-foreground" : "text-muted hover:text-foreground"
      } ${className}`}
    >
      {children}
    </Link>
  );
}

function LocaleToggle() {
  const { locale, setLocale } = useTranslation();
  return (
    <div className="pill !p-0.5">
      {(["en", "sw"] as const).map((l) => (
        <button
          key={l}
          onClick={() => setLocale(l)}
          className={`rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase transition ${
            locale === l ? "bg-accent text-white" : "text-muted hover:text-foreground"
          }`}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

export default function Navbar() {
  const { user } = useAppSession();
  const router = useRouter();
  const { t } = useTranslation();
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // The vendor portal (Session 8) is a separate, mobile-first, minimal-
  // chrome surface built for a phone in bright outdoor light — it has its
  // own sign-out control and no use for this organiser/buyer nav (whose own
  // useAppSession() cache doesn't even model a VENDOR session's fields).
  const isVendorPortal = pathname?.startsWith("/vendor");

  // Close the mobile "Account" menu whenever the route changes (a NavLink
  // click inside it navigates before this effect runs, so this is the
  // catch-all for browser back/forward too) and on outside click.
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!menuOpen) return;
    function onClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [menuOpen]);

  if (isVendorPortal) return null;

  const closeMenu = () => setMenuOpen(false);

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-2 px-4 py-3 sm:gap-4 sm:px-6">
        <Link href="/" className="flex flex-shrink-0 items-center gap-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icon.svg" alt="" className="h-9 w-9 flex-shrink-0 rounded-lg" />
          <span className="flex flex-col leading-none">
            <span className="font-display text-base font-extrabold tracking-tight text-silver">
              CHAAP
            </span>
          </span>
        </Link>

        <nav className="hidden items-center gap-6 md:flex">
          <NavLink href="/events">{t("nav.browse")}</NavLink>
          {user && <NavLink href="/account/tickets">{t("nav.myTickets")}</NavLink>}
          {user && <NavLink href="/account/vendor-applications">{t("nav.myVendorApps")}</NavLink>}
          {user && <NavLink href="/account/wallet">{t("nav.myWallets")}</NavLink>}
          {user && <NavLink href="/account/groups">{t("nav.myGroups")}</NavLink>}
          {user && <NavLink href="/account/sessions">{t("nav.sessions")}</NavLink>}
          {user && <NavLink href="/account/loyalty">{t("nav.myStatus")}</NavLink>}
          {user && <NavLink href="/account/rewards">{t("nav.myRewards")}</NavLink>}
          {user && <NavLink href="/account/support">{t("nav.support")}</NavLink>}
          {user && <NavLink href="/dashboard">{t("nav.dashboard")}</NavLink>}
          {user?.organizationRole === "OWNER" && <NavLink href="/dashboard/team">{t("nav.team")}</NavLink>}
          {user?.organizationRole === "OWNER" && <NavLink href="/dashboard/audit">{t("nav.auditLog")}</NavLink>}
          {user?.organizationRole === "OWNER" && <NavLink href="/dashboard/devices">{t("nav.devices")}</NavLink>}
          {user && user.organizationRole !== "GATE_CREW" && <NavLink href="/dashboard/analytics">{t("nav.analytics")}</NavLink>}
          {user && user.organizationRole !== "GATE_CREW" && <NavLink href="/dashboard/customers">{t("nav.customers")}</NavLink>}
          {user && user.organizationRole !== "GATE_CREW" && <NavLink href="/dashboard/support">{t("nav.supportInbox")}</NavLink>}
          {user && user.organizationRole !== "GATE_CREW" && <NavLink href="/dashboard/withdrawals">{t("nav.withdrawals")}</NavLink>}
          {user && user.organizationRole !== "GATE_CREW" && <NavLink href="/dashboard/payments">{t("nav.payments")}</NavLink>}
          {user && user.organizationRole !== "GATE_CREW" && <NavLink href="/dashboard/settlements">{t("nav.settlements")}</NavLink>}
          {user?.role === "ADMIN" && <NavLink href="/admin">{t("nav.admin")}</NavLink>}
        </nav>

        <div className="flex items-center gap-2 sm:gap-3">
          <LocaleToggle />
          <div className="hidden sm:block">
            <SyncStatusBadge />
          </div>
          {user ? (
            <div className="flex items-center gap-2">
              <span className="hidden text-sm text-muted sm:inline">{user.name}</span>
              <button
                onClick={() => {
                  signOut({ redirect: false });
                  router.push("/");
                }}
                className="btn-secondary !px-3 !py-1.5 text-xs"
              >
                {t("nav.signOut")}
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Link href="/login" className="btn-secondary whitespace-nowrap !px-3 !py-1.5 text-xs">
                {t("nav.logIn")}
              </Link>
              <Link href="/register" className="btn-primary whitespace-nowrap !px-3 !py-1.5 text-xs">
                {t("nav.signUp")}
              </Link>
            </div>
          )}
        </div>
      </div>

      {/* Mobile top-level row — only Browse / Dashboard / Account stay
          visible here; everything else (My Tickets, My Wallets, Team,
          Withdrawals, ...) moves into the "Account" dropdown below so a
          logged-in OWNER (every seeded demo account included, via
          seed.ts's auto-created personal org) doesn't get a dozen links
          crammed into one row on a phone screen. */}
      <div className="flex items-center gap-5 border-t border-border px-4 py-2 md:hidden">
        <NavLink href="/events">{t("nav.browse")}</NavLink>
        {user && <NavLink href="/dashboard">{t("nav.dashboard")}</NavLink>}
        {user && (
          <div ref={menuRef} className="relative ml-auto">
            <button
              onClick={() => setMenuOpen((v) => !v)}
              aria-expanded={menuOpen}
              aria-haspopup="true"
              className="flex items-center gap-1.5 text-sm font-medium text-muted transition hover:text-foreground"
            >
              <span aria-hidden className="flex flex-col gap-[3px]">
                <span className="block h-0.5 w-4 rounded-full bg-current" />
                <span className="block h-0.5 w-4 rounded-full bg-current" />
                <span className="block h-0.5 w-4 rounded-full bg-current" />
              </span>
              Account
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-full z-50 mt-2 max-h-[70vh] w-64 overflow-y-auto rounded-xl border border-border bg-surface p-2 shadow-lg shadow-black/30">
                <MobileMenuLink href="/account/tickets" onClick={closeMenu}>{t("nav.myTickets")}</MobileMenuLink>
                <MobileMenuLink href="/account/vendor-applications" onClick={closeMenu}>{t("nav.myVendorApps")}</MobileMenuLink>
                <MobileMenuLink href="/account/wallet" onClick={closeMenu}>{t("nav.myWallets")}</MobileMenuLink>
                <MobileMenuLink href="/account/groups" onClick={closeMenu}>{t("nav.myGroups")}</MobileMenuLink>
                <MobileMenuLink href="/account/sessions" onClick={closeMenu}>{t("nav.sessions")}</MobileMenuLink>
                <MobileMenuLink href="/account/loyalty" onClick={closeMenu}>{t("nav.myStatus")}</MobileMenuLink>
                <MobileMenuLink href="/account/rewards" onClick={closeMenu}>{t("nav.myRewards")}</MobileMenuLink>
                <MobileMenuLink href="/account/support" onClick={closeMenu}>{t("nav.support")}</MobileMenuLink>

                {user.organizationRole !== "GATE_CREW" && (
                  <>
                    <MobileMenuDivider />
                    <MobileMenuLink href="/dashboard/analytics" onClick={closeMenu}>{t("nav.analytics")}</MobileMenuLink>
                    <MobileMenuLink href="/dashboard/customers" onClick={closeMenu}>{t("nav.customers")}</MobileMenuLink>
                    <MobileMenuLink href="/dashboard/support" onClick={closeMenu}>{t("nav.supportInbox")}</MobileMenuLink>
                    <MobileMenuLink href="/dashboard/withdrawals" onClick={closeMenu}>{t("nav.withdrawals")}</MobileMenuLink>
                    <MobileMenuLink href="/dashboard/payments" onClick={closeMenu}>{t("nav.payments")}</MobileMenuLink>
                    <MobileMenuLink href="/dashboard/settlements" onClick={closeMenu}>{t("nav.settlements")}</MobileMenuLink>
                  </>
                )}
                {user.organizationRole === "OWNER" && (
                  <>
                    <MobileMenuDivider />
                    <MobileMenuLink href="/dashboard/team" onClick={closeMenu}>{t("nav.team")}</MobileMenuLink>
                    <MobileMenuLink href="/dashboard/audit" onClick={closeMenu}>{t("nav.auditLog")}</MobileMenuLink>
                    <MobileMenuLink href="/dashboard/devices" onClick={closeMenu}>{t("nav.devices")}</MobileMenuLink>
                  </>
                )}
                {user.role === "ADMIN" && (
                  <>
                    <MobileMenuDivider />
                    <MobileMenuLink href="/admin" onClick={closeMenu}>{t("nav.admin")}</MobileMenuLink>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </header>
  );
}

function MobileMenuLink({
  href,
  onClick,
  children,
}: {
  href: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <NavLink href={href} onClick={onClick} className="block rounded-lg px-3 py-2 hover:bg-surface2">
      {children}
    </NavLink>
  );
}

function MobileMenuDivider() {
  return <div className="my-1.5 border-t border-border" />;
}
