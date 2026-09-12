import { redirect } from "next/navigation";
import { auth } from "@/auth";

// Bare /sponsor has no content of its own — same stable-redirect-target
// reasoning as /vendor/page.tsx.
export default async function SponsorIndexPage() {
  const session = await auth();
  if (session?.user?.role === "SPONSOR" && session.user.sponsorId) {
    redirect(`/sponsor/${session.user.sponsorId}/dashboard`);
  }
  redirect("/sponsor/login");
}
