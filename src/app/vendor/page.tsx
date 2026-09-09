import { redirect } from "next/navigation";
import { auth } from "@/auth";

// Bare /vendor has no content of its own — it's just a stable redirect
// target for the verify page (which doesn't yet know its own vendorId at
// the moment signIn() resolves) and anyone who bookmarks/types the bare
// path. Server-rendered so it reads the just-established session cookie
// directly, no client-side session-fetch race.
export default async function VendorIndexPage() {
  const session = await auth();
  if (session?.user?.role === "VENDOR" && session.user.vendorId) {
    redirect(`/vendor/${session.user.vendorId}/dashboard`);
  }
  redirect("/vendor/login");
}
