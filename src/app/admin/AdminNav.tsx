"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// The admin section's tab row. Split out of admin/layout.tsx (a Server
// Component) only because highlighting the current route needs usePathname();
// the links and their order are unchanged.
const LINKS = [
  ["/admin/analytics", "Analytics"],
  ["/admin/users", "Users"],
  ["/admin/events", "Events"],
  ["/admin/orders", "Orders"],
  ["/admin/settlements", "Settlements"],
  ["/admin/notifications", "Notification log"],
] as const;

export default function AdminNav() {
  const pathname = usePathname() ?? "";
  return (
    <nav className="mb-6 flex flex-wrap gap-2">
      {LINKS.map(([href, label]) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link key={href} href={href} aria-current={active ? "page" : undefined} className={`nav-pill ${active ? "nav-pill-active" : ""}`}>
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
