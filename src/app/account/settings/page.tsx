import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getAccountDeletionBlock } from "@/lib/account-deletion";
import DeleteAccountSection from "./DeleteAccountSection";

export default async function SettingsPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login?callbackUrl=/account/settings");
  }

  const blockedReason = await getAccountDeletionBlock(session.user.id);

  return (
    <div className="mx-auto max-w-2xl px-4 pb-20 pt-8 sm:px-6">
      <h1 className="mb-1 text-2xl font-bold">Account Settings</h1>
      <p className="mb-6 text-sm text-muted">Manage your Chaap account.</p>

      <div className="card border-danger/30 p-5">
        <h2 className="mb-1 text-lg font-semibold text-danger">Delete account</h2>
        <p className="mb-4 text-sm text-muted">
          Removes your name, email, and phone number from Chaap and signs you out of every
          device — your login is permanently deactivated. Past tickets and orders are kept for
          financial record-keeping but are no longer linked to your identity.
        </p>
        <DeleteAccountSection blockedReason={blockedReason} />
      </div>
    </div>
  );
}
