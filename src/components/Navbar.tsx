"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { useAppSession } from "@/lib/use-app-session";
import { useTranslation } from "@/lib/use-translation";
import SyncStatusBadge from "@/components/SyncStatusBadge";

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const active = pathname === href || (href !== "/" && pathname.startsWith(href));
  return (
    <Link
      href={href}
      className={`text-sm font-medium transition ${
        active ? "text-foreground" : "text-muted hover:text-foreground"
      }`}
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

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icon.svg" alt="" className="h-9 w-9 rounded-lg" />
          <span className="flex flex-col leading-none">
            <span className="font-display text-base font-extrabold tracking-tight text-silver">
              CHAAP
            </span>
          </span>
        </Link>

        <nav className="hidden items-center gap-6 md:flex">
          <NavLink href="/">{t("nav.browse")}</NavLink>
          {user && <NavLink href="/account/tickets">{t("nav.myTickets")}</NavLink>}
          {user && <NavLink href="/account/vendor-applications">{t("nav.myVendorApps")}</NavLink>}
          {user && <NavLink href="/account/wallet">{t("nav.myWallets")}</NavLink>}
          {user && <NavLink href="/account/sessions">{t("nav.sessions")}</NavLink>}
          {user && <NavLink href="/account/loyalty">{t("nav.myStatus")}</NavLink>}
          {user && <NavLink href="/account/support">{t("nav.support")}</NavLink>}
          {user && <NavLink href="/dashboard">{t("nav.dashboard")}</NavLink>}
          {user?.organizationRole === "OWNER" && <NavLink href="/dashboard/team">{t("nav.team")}</NavLink>}
          {user?.organizationRole === "OWNER" && <NavLink href="/dashboard/audit">{t("nav.auditLog")}</NavLink>}
          {user?.organizationRole === "OWNER" && <NavLink href="/dashboard/devices">{t("nav.devices")}</NavLink>}
          {user && user.organizationRole !== "GATE_CREW" && <NavLink href="/dashboard/customers">{t("nav.customers")}</NavLink>}
          {user && user.organizationRole !== "GATE_CREW" && <NavLink href="/dashboard/support">{t("nav.supportInbox")}</NavLink>}
          {user && user.organizationRole !== "GATE_CREW" && <NavLink href="/dashboard/withdrawals">{t("nav.withdrawals")}</NavLink>}
          {user && user.organizationRole !== "GATE_CREW" && <NavLink href="/dashboard/payments">{t("nav.payments")}</NavLink>}
          {user?.role === "ADMIN" && <NavLink href="/admin">{t("nav.admin")}</NavLink>}
        </nav>

        <div className="flex items-center gap-3">
          <LocaleToggle />
          <SyncStatusBadge />
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
              <Link href="/login" className="btn-secondary !px-3 !py-1.5 text-xs">
                {t("nav.logIn")}
              </Link>
              <Link href="/register" className="btn-primary !px-3 !py-1.5 text-xs">
                {t("nav.signUp")}
              </Link>
            </div>
          )}
        </div>
      </div>
      <div className="flex gap-5 border-t border-border px-4 py-2 md:hidden">
        <NavLink href="/">{t("nav.browse")}</NavLink>
        {user && <NavLink href="/account/tickets">{t("nav.myTickets")}</NavLink>}
        {user && <NavLink href="/account/sessions">{t("nav.sessions")}</NavLink>}
        {user && <NavLink href="/dashboard">{t("nav.dashboard")}</NavLink>}
        {user?.organizationRole === "OWNER" && <NavLink href="/dashboard/team">{t("nav.team")}</NavLink>}
        {user?.organizationRole === "OWNER" && <NavLink href="/dashboard/audit">{t("nav.auditLog")}</NavLink>}
        {user?.organizationRole === "OWNER" && <NavLink href="/dashboard/devices">{t("nav.devices")}</NavLink>}
        {user && user.organizationRole !== "GATE_CREW" && <NavLink href="/dashboard/customers">{t("nav.customers")}</NavLink>}
        {user && user.organizationRole !== "GATE_CREW" && <NavLink href="/dashboard/withdrawals">{t("nav.withdrawals")}</NavLink>}
        {user && user.organizationRole !== "GATE_CREW" && <NavLink href="/dashboard/payments">{t("nav.payments")}</NavLink>}
        {user?.role === "ADMIN" && <NavLink href="/admin">{t("nav.admin")}</NavLink>}
      </div>
    </header>
  );
}
