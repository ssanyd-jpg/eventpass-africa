"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/lib/db";
import { useAppSession } from "@/lib/use-app-session";
import { useTranslation } from "@/lib/use-translation";
import SyncStatusBadge from "@/components/SyncStatusBadge";

// Highlights the "Account" dropdown as active — wallet/groups/rewards moved
// out to their own top-level links (or the organiser-only "More" dropdown,
// which tracks its own active state separately), so this now covers just
// the plain account-management pages left inside "Account".
const MORE_PREFIXES = [
  "/account/sessions",
  "/account/loyalty",
  "/account/support",
  "/account/vendor-applications",
  "/account/settings",
];

function NavLink({
  href,
  children,
  className = "",
  onClick,
  chrome = false,
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
  onClick?: () => void;
  // true for links sitting directly on the gradient header (chip treatment);
  // false for links inside a dropdown/menu panel, which is a plain card.
  chrome?: boolean;
}) {
  const pathname = usePathname();
  const active = pathname === href || (href !== "/" && pathname.startsWith(href));
  return (
    <Link
      href={href}
      onClick={onClick}
      className={`text-sm font-medium transition ${
        chrome
          ? `nav-chip ${active ? "nav-chip-active" : ""}`
          : active
            ? "text-foreground"
            : "text-muted hover:text-foreground"
      } ${className}`}
    >
      {children}
    </Link>
  );
}

// Desktop-only dropdown used for "Dashboard" (when it has sub-pages) and
// "More" — mirrors the mobile Account sheet's click-outside-to-close
// behavior, but closes on any inner link click via event bubbling instead of
// an explicit onClick per link (Next's <Link> renders a plain <a>, so a
// native click still bubbles to this wrapper before navigation completes).
function DesktopDropdown({
  label,
  active,
  children,
}: {
  label: string;
  active: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="true"
        className={`nav-chip flex items-center gap-1 text-sm font-medium transition ${
          active ? "nav-chip-active" : ""
        }`}
      >
        {label}
        <svg
          aria-hidden
          viewBox="0 0 20 20"
          fill="currentColor"
          className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path
            fillRule="evenodd"
            d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.06l3.71-3.83a.75.75 0 1 1 1.08 1.04l-4.25 4.39a.75.75 0 0 1-1.08 0L5.21 8.27a.75.75 0 0 1 .02-1.06z"
            clipRule="evenodd"
          />
        </svg>
      </button>
      {open && (
        <div
          onClick={() => setOpen(false)}
          className="absolute left-0 top-full z-50 mt-2 w-56 rounded-xl border border-border bg-surface p-2 shadow-lg shadow-black/30"
        >
          {children}
        </div>
      )}
    </div>
  );
}

function DropdownLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <NavLink href={href} className="block rounded-lg px-3 py-2 hover:bg-surface2">
      {children}
    </NavLink>
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
            locale === l ? "bg-accent text-background" : "text-on-chrome hover:text-white"
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
  const isGateCrew = user?.organizationRole === "GATE_CREW";

  // Every user is OWNER of at least their own personal org from the moment
  // they register (see createPersonalOrganization in src/lib/organizations.ts
  // — "every user belongs to exactly one organization, always") — so
  // organizationRole alone can never distinguish a plain attendee from a
  // real organiser; both read as "OWNER". Whether that org has ever actually
  // run an event is the only signal that does, hence this live count against
  // the already-synced local events this device has for the org (same
  // Dexie query dashboard/page.tsx already runs). While it's still resolving
  // (undefined), default to "no events yet" — briefly under-showing the
  // organiser nav for a real organiser self-corrects in a moment, whereas
  // briefly over-showing it to a true attendee reintroduces the exact
  // confusion this is meant to fix.
  const eventCount = useLiveQuery(
    () => (user ? db.events.where("organizationId").equals(user.organizationId).count() : Promise.resolve(0)),
    [user?.organizationId]
  );
  const hasEvents = (eventCount ?? 0) > 0;
  // A real organiser: not gate crew, and their org has at least one event.
  // Everyone else logged in (true attendees, and a brand-new organiser who
  // hasn't created their first event yet) gets the attendee-level nav below,
  // plus — only for that brand-new-organiser case — a plain Dashboard link
  // so they're never stranded without a way to create that first event.
  const isOrganiser = !isGateCrew && hasEvents;

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
    <header className="sticky top-0 z-40 border-b border-chrome-border bg-chrome-topbar">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-2 px-4 py-3 sm:gap-4 sm:px-6">
        <Link href="/" className="flex flex-shrink-0 items-center gap-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/chaap-icon.webp" alt="" className="h-9 w-9 flex-shrink-0 rounded-lg" />
          <span className="flex flex-col leading-none">
            <span className="font-display text-base font-extrabold tracking-tight text-silver">
              CHAAP
            </span>
          </span>
        </Link>

        {/* Each user type sees only what's relevant to them — gate crew get
            just the scanner and their own status; a true attendee (every
            signed-up user is technically "OWNER" of their own personal org,
            see isOrganiser above, so this is NOT an organizationRole check)
            never sees organiser back-office tooling; a real organiser gets
            Dashboard as its own dropdown (the only place Analytics,
            Customers, Withdrawals, Payments, Settlements, Team, Audit Log,
            Devices, Admin are reachable from) plus a "More" dropdown for
            their own wallets/groups/rewards so the top row doesn't grow
            past Browse / Dashboard / My Tickets / More. */}
        <nav className="hidden items-center gap-6 lg:flex">
          <NavLink href="/events" chrome>{t("nav.browse")}</NavLink>

          {isGateCrew && (
            <>
              <NavLink href="/dashboard" chrome>{t("nav.scan")}</NavLink>
              <NavLink href="/account/loyalty" chrome>{t("nav.myStatus")}</NavLink>
              <NavLink href="/account/settings" chrome>{t("nav.account")}</NavLink>
            </>
          )}

          {user && !isGateCrew && (
            <>
              {isOrganiser ? (
                <DesktopDropdown label={t("nav.dashboard")} active={pathname?.startsWith("/dashboard") ?? false}>
                  <DropdownLink href="/dashboard">{t("nav.dashboard")}</DropdownLink>
                  <DropdownLink href="/dashboard/analytics">{t("nav.analytics")}</DropdownLink>
                  <DropdownLink href="/dashboard/customers">{t("nav.customers")}</DropdownLink>
                  <DropdownLink href="/dashboard/support">{t("nav.supportInbox")}</DropdownLink>
                  <DropdownLink href="/dashboard/withdrawals">{t("nav.withdrawals")}</DropdownLink>
                  <DropdownLink href="/dashboard/payments">{t("nav.payments")}</DropdownLink>
                  <DropdownLink href="/dashboard/settlements">{t("nav.settlements")}</DropdownLink>
                  <DropdownLink href="/dashboard/season-passes">{t("nav.seasonPasses")}</DropdownLink>
                  <DropdownLink href="/dashboard/ads">{t("nav.ads")}</DropdownLink>
                  {user.organizationRole === "OWNER" && (
                    <>
                      <MenuDivider />
                      <DropdownLink href="/dashboard/team">{t("nav.team")}</DropdownLink>
                      <DropdownLink href="/dashboard/audit">{t("nav.auditLog")}</DropdownLink>
                      <DropdownLink href="/dashboard/devices">{t("nav.devices")}</DropdownLink>
                    </>
                  )}
                  {user.role === "ADMIN" && (
                    <>
                      <MenuDivider />
                      <DropdownLink href="/admin">{t("nav.admin")}</DropdownLink>
                    </>
                  )}
                </DesktopDropdown>
              ) : (
                // Not yet a real organiser (no events of their own) — still
                // a plain Dashboard link, never a dead end on the day they
                // decide to create their first event.
                <NavLink href="/dashboard" chrome>{t("nav.dashboard")}</NavLink>
              )}

              <NavLink href="/account/tickets" chrome>{t("nav.myTickets")}</NavLink>

              {isOrganiser ? (
                <DesktopDropdown label={t("nav.more")} active={["/account/wallet", "/account/groups", "/account/rewards"].some((p) => pathname?.startsWith(p))}>
                  <DropdownLink href="/account/wallet">{t("nav.myWallets")}</DropdownLink>
                  <DropdownLink href="/account/groups">{t("nav.myGroups")}</DropdownLink>
                  <DropdownLink href="/account/rewards">{t("nav.myRewards")}</DropdownLink>
                </DesktopDropdown>
              ) : (
                <>
                  <NavLink href="/account/wallet" chrome>{t("nav.myWallets")}</NavLink>
                  <NavLink href="/account/groups" chrome>{t("nav.myGroups")}</NavLink>
                  <NavLink href="/account/rewards" chrome>{t("nav.myRewards")}</NavLink>
                </>
              )}

              <DesktopDropdown label={t("nav.account")} active={MORE_PREFIXES.some((p) => pathname?.startsWith(p))}>
                <DropdownLink href="/account/sessions">{t("nav.sessions")}</DropdownLink>
                <DropdownLink href="/account/loyalty">{t("nav.myStatus")}</DropdownLink>
                <DropdownLink href="/account/support">{t("nav.support")}</DropdownLink>
                <DropdownLink href="/account/settings">{t("nav.settings")}</DropdownLink>
                <MenuDivider />
                <DropdownLink href="/account/vendor-applications">{t("nav.myVendorApps")}</DropdownLink>
              </DesktopDropdown>
            </>
          )}
        </nav>

        <div className="flex items-center gap-2 sm:gap-3">
          <LocaleToggle />
          <div className="hidden sm:block [&>.pill]:text-on-chrome">
            <SyncStatusBadge />
          </div>
          {user ? (
            <div className="flex items-center gap-2">
              <span className="hidden max-w-[12rem] truncate text-sm text-on-chrome sm:inline">{user.name}</span>
              <button
                onClick={() => {
                  signOut({ redirect: false });
                  router.push("/");
                }}
                className="btn-secondary flex-shrink-0 whitespace-nowrap !px-3 !py-1.5 !text-on-chrome text-xs"
              >
                {t("nav.signOut")}
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Link href="/login" className="btn-secondary whitespace-nowrap !px-3 !py-1.5 !text-on-chrome text-xs">
                {t("nav.logIn")}
              </Link>
              <Link href="/register" className="btn-primary whitespace-nowrap !px-3 !py-1.5 text-xs">
                {t("nav.signUp")}
              </Link>
            </div>
          )}
        </div>
      </div>

      {/* Mobile top-level row. Gate crew get exactly Scan / My Status /
          Account and nothing else — no hamburger, nothing to tuck away.
          Everyone else keeps Browse / Dashboard visible, with the rest
          (My Tickets, My Wallets, organiser back-office pages, ...) inside
          the "Account" dropdown below, gated the same way the desktop nav
          is — isOrganiser (not organizationRole) is what decides whether
          the organiser-only sections appear, since every user is
          technically "OWNER" of their own personal org by default. */}
      <div className="flex items-center gap-5 border-t border-chrome-border px-4 py-2 sm:px-6 lg:hidden">
        <NavLink href="/events" chrome>{t("nav.browse")}</NavLink>

        {isGateCrew && (
          <>
            <NavLink href="/dashboard" chrome>{t("nav.scan")}</NavLink>
            <NavLink href="/account/loyalty" chrome>{t("nav.myStatus")}</NavLink>
            <NavLink href="/account/settings" chrome className="ml-auto">{t("nav.account")}</NavLink>
          </>
        )}

        {user && !isGateCrew && <NavLink href="/dashboard" chrome>{t("nav.dashboard")}</NavLink>}
        {user && !isGateCrew && (
          <div ref={menuRef} className="relative ml-auto">
            <button
              onClick={() => setMenuOpen((v) => !v)}
              aria-expanded={menuOpen}
              aria-haspopup="true"
              className="nav-chip flex items-center gap-1.5 text-sm font-medium transition"
            >
              <span aria-hidden className="flex flex-col gap-[3px]">
                <span className="block h-0.5 w-4 rounded-full bg-current" />
                <span className="block h-0.5 w-4 rounded-full bg-current" />
                <span className="block h-0.5 w-4 rounded-full bg-current" />
              </span>
              {t("nav.account")}
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-full z-50 mt-2 max-h-[70vh] w-64 overflow-y-auto rounded-xl border border-border bg-surface p-2 shadow-lg shadow-black/30">
                <MobileMenuLink href="/account/tickets" onClick={closeMenu}>{t("nav.myTickets")}</MobileMenuLink>
                <MobileMenuLink href="/account/wallet" onClick={closeMenu}>{t("nav.myWallets")}</MobileMenuLink>
                <MobileMenuLink href="/account/groups" onClick={closeMenu}>{t("nav.myGroups")}</MobileMenuLink>
                <MobileMenuLink href="/account/rewards" onClick={closeMenu}>{t("nav.myRewards")}</MobileMenuLink>
                <MobileMenuLink href="/account/sessions" onClick={closeMenu}>{t("nav.sessions")}</MobileMenuLink>
                <MobileMenuLink href="/account/loyalty" onClick={closeMenu}>{t("nav.myStatus")}</MobileMenuLink>
                <MobileMenuLink href="/account/support" onClick={closeMenu}>{t("nav.support")}</MobileMenuLink>
                <MobileMenuLink href="/account/settings" onClick={closeMenu}>{t("nav.settings")}</MobileMenuLink>
                <MobileMenuLink href="/account/vendor-applications" onClick={closeMenu}>{t("nav.myVendorApps")}</MobileMenuLink>

                {isOrganiser && (
                  <>
                    <MenuDivider />
                    <MobileMenuLink href="/dashboard/analytics" onClick={closeMenu}>{t("nav.analytics")}</MobileMenuLink>
                    <MobileMenuLink href="/dashboard/customers" onClick={closeMenu}>{t("nav.customers")}</MobileMenuLink>
                    <MobileMenuLink href="/dashboard/support" onClick={closeMenu}>{t("nav.supportInbox")}</MobileMenuLink>
                    <MobileMenuLink href="/dashboard/withdrawals" onClick={closeMenu}>{t("nav.withdrawals")}</MobileMenuLink>
                    <MobileMenuLink href="/dashboard/payments" onClick={closeMenu}>{t("nav.payments")}</MobileMenuLink>
                    <MobileMenuLink href="/dashboard/settlements" onClick={closeMenu}>{t("nav.settlements")}</MobileMenuLink>
                    <MobileMenuLink href="/dashboard/season-passes" onClick={closeMenu}>{t("nav.seasonPasses")}</MobileMenuLink>
                    <MobileMenuLink href="/dashboard/ads" onClick={closeMenu}>{t("nav.ads")}</MobileMenuLink>
                  </>
                )}
                {isOrganiser && user.organizationRole === "OWNER" && (
                  <>
                    <MenuDivider />
                    <MobileMenuLink href="/dashboard/team" onClick={closeMenu}>{t("nav.team")}</MobileMenuLink>
                    <MobileMenuLink href="/dashboard/audit" onClick={closeMenu}>{t("nav.auditLog")}</MobileMenuLink>
                    <MobileMenuLink href="/dashboard/devices" onClick={closeMenu}>{t("nav.devices")}</MobileMenuLink>
                  </>
                )}
                {user.role === "ADMIN" && (
                  <>
                    <MenuDivider />
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

function MenuDivider() {
  return <div className="my-1.5 border-t border-border" />;
}
