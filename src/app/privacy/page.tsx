import type { Metadata } from "next";
import LegalDocument, { LegalSection, Placeholder } from "@/components/LegalDocument";

export const metadata: Metadata = {
  title: "Privacy Policy — Chaap",
  description: "How Chaap collects, uses, and protects your information.",
};

// Drafted from what this codebase actually does (see the models in
// prisma/schema.prisma, the integrations in src/lib/{email,sms,whatsapp,
// payments/airpay}.ts, the offline store in src/lib/db.ts, and the deletion
// flow in src/lib/account-deletion.ts) rather than generic boilerplate —
// but every Placeholder below is a fact only Chaap's own team can supply
// (legal entity name, registered address, a lawyer-reviewed data-residency
// statement). Fill those in, and have a lawyer review the whole page,
// before treating this as final.
export default function PrivacyPolicyPage() {
  return (
    <LegalDocument title="Privacy Policy">
      <p className="text-sm leading-relaxed text-muted">
        This policy covers chaap.africa and the Chaap app — whether you&apos;re buying a ticket, topping up a
        cashless wallet, organizing an event, running a vendor stall or sponsor activation, volunteering, or just
        getting in touch with us. In this policy, &ldquo;Chaap&rdquo;, &ldquo;we&rdquo;, and &ldquo;us&rdquo; mean{" "}
        <Placeholder>[legal entity name]</Placeholder>.
      </p>

      <LegalSection title="Information we collect">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong>Account information:</strong> your name, email address, and password (we only ever store a
            one-way hash of your password, never the password itself). We only collect a phone number if you
            provide one — currently that happens if you pay by mobile money at checkout, since that&apos;s the
            number the payment and an SMS/WhatsApp receipt go to.
          </li>
          <li>
            <strong>Orders and tickets:</strong> what you bought, your ticket&apos;s scan code, any waiver you
            accepted, and — if an event uses NFC wristbands — your wristband&apos;s unique ID.
          </li>
          <li>
            <strong>Cashless wallet:</strong> your balance, top-ups, and what you spend with vendors at an event;
            if you top up or withdraw by mobile money, the phone number and network used for that transaction.
          </li>
          <li>
            <strong>Organizer, vendor, and sponsor information:</strong> if you run an event, a stall, or a sponsor
            activation on Chaap, your business name, contact details, and payout account details for settlements.
          </li>
          <li>
            <strong>Volunteers and waitlists:</strong> your name, phone number, and optionally email, if you sign
            up to volunteer at an event or join a waitlist.
          </li>
          <li>
            <strong>Support messages:</strong> anything you send us, or an event organizer, through in-app Support.
          </li>
          <li>
            <strong>Device information:</strong> an identifier your phone or tablet generates so gate-scanning and
            vendor devices keep working offline and can sync once reconnected, and basic sign-in activity for
            security.
          </li>
        </ul>
      </LegalSection>

      <LegalSection title="What we don't collect">
        <p>
          We never see or store your card number, mobile money PIN, or banking credentials. Payments are processed
          by AirPay Tanzania — Chaap only ever receives a payment reference and a status (pending, paid, or
          failed); you confirm every mobile money charge yourself, directly on your own phone.
        </p>
        <p>
          We also don&apos;t run any third-party advertising or analytics trackers — no Google Analytics, no Meta
          Pixel, nothing like it. The only analytics on Chaap are the first-party numbers an organizer sees about
          their own event.
        </p>
      </LegalSection>

      <LegalSection title="How we use your information">
        <ul className="list-disc space-y-2 pl-5">
          <li>to create and run your account, process ticket purchases, and manage your cashless wallet;</li>
          <li>to let you check in at a gate and spend with vendors, including while offline;</li>
          <li>to send order confirmations, receipts, and service messages by email, SMS, or WhatsApp;</li>
          <li>to give event organizers what they need to run their event (see below);</li>
          <li>to detect fraud, keep the platform secure, and enforce our Terms of Service; and</li>
          <li>to meet our legal and accounting obligations, such as keeping financial records.</li>
        </ul>
      </LegalSection>

      <LegalSection title="Who we share information with">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong>Event organizers</strong> can see information about tickets bought for, and attendees checked
            in at, their own event — your name, order/ticket status, and anything you choose to share with them,
            like a support message. An organizer can&apos;t see your password or your activity on other
            organizers&apos; events.
          </li>
          <li>
            <strong>Vendors and sponsors</strong> see only the wallet transaction (amount and item) when you tap
            your wristband with them, or that you visited a sponsor activation you scanned at — never your full
            account details.
          </li>
          <li>
            <strong>Service providers</strong> who process data on our behalf: AirPay Tanzania (payments),
            Africa&apos;s Talking (SMS and WhatsApp delivery), Resend (transactional email), Vercel (hosting and
            file storage for event photos and logos), and Neon (our database host). Each only receives what it
            needs to do its job for us and isn&apos;t allowed to use your information for its own purposes.
          </li>
          <li>
            <strong>WhatsApp groups:</strong> if an event has a WhatsApp group and you&apos;re opted in — either by
            choice or by the organizer&apos;s default for that ticket type, which you can always change afterward
            from your ticket — we send you the organizer&apos;s own group invite link. Chaap never creates a
            WhatsApp group or adds you to one itself; that can only be done by the organizer, on their own phone.
            Our part is relaying the invite link to attendees who are opted in.
          </li>
          <li>
            <strong>Legal requirements:</strong> if the law requires it, or to protect the rights, property, or
            safety of Chaap, our users, or the public.
          </li>
        </ul>
        <p>We do not sell your personal information, to anyone, ever.</p>
      </LegalSection>

      <LegalSection title="Offline data on your device">
        <p>
          Chaap is built to keep working without a connection — at a gate with no signal, or a vendor stall in a
          dead zone. To make that possible, your phone or tablet keeps a local copy of the data it needs (your
          tickets, your wallet, recent transactions, and similar) in your browser&apos;s on-device storage, and
          syncs it back to our servers once you&apos;re reconnected. That copy stays on your device; clearing your
          browser&apos;s site data removes it from your device, but any already-synced copy remains on our servers
          as described in this policy.
        </p>
      </LegalSection>

      <LegalSection title="Cookies and similar technologies">
        <p>
          We use one cookie: the sign-in session that keeps you logged in. We also use your browser&apos;s local
          storage to remember a few preferences on your own device — your chosen language, a high-contrast display
          setting, and whether you&apos;ve already seen or dismissed a prompt like the install-this-app banner.
          None of this is used to track you across other sites, and we don&apos;t use third-party advertising or
          tracking cookies.
        </p>
      </LegalSection>

      <LegalSection title="How long we keep information">
        <p>
          We keep your account information for as long as your account is active. If you delete your account (see
          &ldquo;Your rights&rdquo; below), we anonymize your profile immediately rather than deleting your orders
          and transactions outright — ticket, payment, and settlement records need to stay intact for accounting,
          tax, and fraud-prevention purposes, for organizers and for us. Once anonymized, those historical records
          are no longer linked to your name or contact details.
        </p>
      </LegalSection>

      <LegalSection title="Your rights">
        <ul className="list-disc space-y-2 pl-5">
          <li>View and update your account details at any time from your account settings.</li>
          <li>Ask us what information we hold about you.</li>
          <li>
            Delete your account directly from Account → Settings. This immediately anonymizes your name, email,
            and phone number, signs you out everywhere, and removes your saved password — it doesn&apos;t delete
            your order or ticket history, for the accounting reasons above, but that history is no longer linked
            to you by name once your account is anonymized. If you&apos;re the sole owner of an organization with
            a live or upcoming event, you&apos;ll need to transfer ownership or wait until the event ends first.
          </li>
          <li>Opt out of a WhatsApp group at any time from your ticket.</li>
        </ul>
        <p>
          These rights are provided under, and this policy is written to meet, Tanzania&apos;s Personal Data
          Protection Act, 2022 (PDPA).{" "}
          <Placeholder>
            [If Chaap has users in other countries with their own data protection laws, confirm with a lawyer
            whether this section needs more.]
          </Placeholder>
        </p>
      </LegalSection>

      <LegalSection title="Children">
        <p>
          Chaap isn&apos;t directed at children, and you must be at least 18 to create an account or make a
          purchase. If you&apos;re under 18, a parent or guardian needs to create the account and buy tickets on
          your behalf.
        </p>
      </LegalSection>

      <LegalSection title="Where your information is stored">
        <p>
          Our database and file storage run on our infrastructure providers (Neon and Vercel), which may store
          information outside Tanzania.{" "}
          <Placeholder>[Confirm the exact hosting region(s) with your infrastructure team if you want to state it specifically here.]</Placeholder>
        </p>
      </LegalSection>

      <LegalSection title="Security">
        <p>
          We store your password as a one-way hash, never in plain text, and send data over encrypted connections.
          No system is perfectly secure, but we work to protect your information and will tell you if a breach
          puts your personal information at meaningful risk.
        </p>
      </LegalSection>

      <LegalSection title="Changes to this policy">
        <p>
          If we make a material change to this policy, we&apos;ll update the effective date above and, where
          appropriate, let you know directly.
        </p>
      </LegalSection>

      <LegalSection title="Contact us">
        <p>
          Questions about this policy, or a request about your information? Reach us through Support in your Chaap
          account, or email <Placeholder>[support contact email]</Placeholder>.{" "}
          <Placeholder>[Legal entity name and registered address, if you want them listed here.]</Placeholder>
        </p>
      </LegalSection>
    </LegalDocument>
  );
}
