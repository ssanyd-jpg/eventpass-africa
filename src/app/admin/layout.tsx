import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/auth";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (session?.user?.role !== "ADMIN") {
    redirect("/login?callbackUrl=/admin");
  }

  return (
    <div className="mx-auto max-w-5xl px-4 pb-20 pt-8 sm:px-6">
      <h1 className="text-2xl font-bold">Admin</h1>
      <p className="mb-6 text-sm text-muted">Platform moderation & pilot support tools.</p>
      <nav className="mb-6 flex flex-wrap gap-2">
        {[
          ["/admin/users", "Users"],
          ["/admin/events", "Events"],
          ["/admin/orders", "Orders"],
          ["/admin/settlements", "Settlements"],
          ["/admin/notifications", "Notification log"],
        ].map(([href, label]) => (
          <Link key={href} href={href} className="pill hover:border-accent hover:text-foreground">
            {label}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  );
}
