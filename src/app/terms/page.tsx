import type { Metadata } from "next";
import LegalDocument, { LegalSection, Placeholder } from "@/components/LegalDocument";

export const metadata: Metadata = {
  title: "Terms of Service — Chaap",
  description: "The terms that cover buying, organizing, and selling on Chaap.",
};

// Same drafting basis as src/app/privacy/page.tsx — grounded in what the
// platform actually does, with Placeholder marking the handful of clauses
// (limitation of liability, dispute venue, legal entity name) that need a
// lawyer and Chaap's own team, not a guess from the codebase.
export default function TermsOfServicePage() {
  return (
    <LegalDocument title="Terms of Service">
      <p className="text-sm leading-relaxed text-muted">
        By creating a Chaap account, buying a ticket, topping up or spending from a Chaap wallet, or using Chaap as
        an organizer, vendor, sponsor, or volunteer, you agree to these Terms. If you don&apos;t agree, please
        don&apos;t use Chaap.
      </p>

      <LegalSection title="What Chaap is">
        <p>
          Chaap is an event ticketing and cashless-payments platform for East Africa. Depending on how you use it,
          Chaap lets you buy tickets to events and show them — as a QR code or an NFC wristband — to get in; top up
          and spend a cashless wallet at vendors during an event; and, if you organize events, create and run
          them: sell tickets, check attendees in, manage vendors and sponsors, and receive payouts.
        </p>
      </LegalSection>

      <LegalSection title="Your account">
        <ul className="list-disc space-y-2 pl-5">
          <li>You must be at least 18 to create an account or buy a ticket. If you&apos;re under 18, a parent or guardian must do this for you.</li>
          <li>
            You&apos;re responsible for keeping your password secure and for everything that happens under your
            account. Tell us right away through Support if you think someone else has access to it.
          </li>
          <li>You agree to give us accurate information when you register and to keep it up to date.</li>
        </ul>
      </LegalSection>

      <LegalSection title="Buying tickets and using the wallet">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            When you buy a ticket, you&apos;ll see the price, any fees, and the payment method before you confirm.
            Payment is processed by AirPay Tanzania — Chaap never sees your card number or mobile money PIN.
          </li>
          <li>
            Your ticket is the QR code or wristband tied to it — keep it safe, the same way you would a paper
            ticket. A ticket can normally be used to check in once, unless the organizer sets it up otherwise (for
            example, for a multi-day event).
          </li>
          <li>
            A Chaap wallet balance is only usable at vendors participating in the event(s) it&apos;s tied to, as
            set by the organizer — check the event page for specifics on how long a balance stays valid and
            whether it carries over to another event.
          </li>
          <li>
            Chaap can also work offline: if you buy a ticket or spend from your wallet with no connection,
            it&apos;s recorded on your device and confirmed once you&apos;re back online. In rare cases a purchase
            made offline can be declined once it syncs — for example, if the event sold out in the meantime — and
            if that happens, any amount charged is reversed.
          </li>
        </ul>
      </LegalSection>

      <LegalSection title="Transfers and resale">
        <p>
          You may transfer a ticket you hold to someone else where Chaap offers that option, and resell a ticket
          through Chaap&apos;s own resale feature, where an organizer has enabled it, at or below the price the
          organizer allows. Reselling or transferring a Chaap ticket outside of Chaap&apos;s own tools, or at a
          markup the organizer hasn&apos;t allowed, may get the ticket cancelled without a refund.
        </p>
      </LegalSection>

      <LegalSection title="Refunds and cancellations">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            Refund policies — whether tickets are refundable, and under what conditions — are set by the event
            organizer, not by Chaap. Check the specific event&apos;s policy before you buy.
          </li>
          <li>
            If an event is cancelled, or a payment fails partway through, Chaap works with the organizer and
            AirPay to reverse the charge; this can take a few business days depending on your mobile money
            provider or bank.
          </li>
          <li>
            Chaap facilitates payment between you and the organizer; we&apos;re not the merchant of record for the
            event itself unless the event page says otherwise.
          </li>
        </ul>
      </LegalSection>

      <LegalSection title="If you organize events on Chaap">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            You&apos;re responsible for the accuracy of your event listing, for complying with the law wherever
            your event happens (licensing, safety, tax, and anything else that applies to you), and for honoring
            the ticket and refund terms you set.
          </li>
          <li>
            You&apos;re responsible for how you use the attendee information Chaap gives you access to — only use
            it to run your event, and don&apos;t share it beyond what&apos;s reasonably needed for that. Our{" "}
            <a href="/privacy">Privacy Policy</a> covers exactly what you can see.
          </li>
          <li>
            Settlement of funds you&apos;ve collected happens on the schedule, and to the payout account, shown in
            your dashboard — you&apos;re responsible for keeping that payout information correct.
          </li>
          <li>
            Chaap may remove an event, or suspend an organizer account, that we reasonably believe is fraudulent,
            unsafe, or breaks these Terms or the law.
          </li>
        </ul>
      </LegalSection>

      <LegalSection title="If you're a vendor or sponsor at an event">
        <p>
          You&apos;re responsible for the accuracy of the goods, services, and prices you list, and for honoring
          the sales a Chaap wallet tap records. Settlement works the same way as for organizers — on the schedule
          shown in your dashboard, to your registered payout details.
        </p>
      </LegalSection>

      <LegalSection title="Acceptable use">
        <p>You agree not to:</p>
        <ul className="list-disc space-y-2 pl-5">
          <li>use Chaap to commit fraud, launder money, or evade a payment you owe;</li>
          <li>fake, duplicate, or tamper with a ticket, wristband, or QR code;</li>
          <li>access another person&apos;s account, or a gate-scanning or vendor device, without authorization;</li>
          <li>interfere with, reverse-engineer, or try to disrupt the platform, including the offline-sync mechanism; or</li>
          <li>use Chaap for an event or purpose that&apos;s illegal where it takes place.</li>
        </ul>
        <p>We may suspend or terminate an account that breaks this.</p>
      </LegalSection>

      <LegalSection title="Intellectual property">
        <p>
          Chaap, our logo, and the Chaap platform belong to us or our licensors. Using Chaap doesn&apos;t give you
          any ownership in it. Content organizers post — event descriptions, photos — stays theirs, but by posting
          it they give Chaap permission to display it as part of running the platform.
        </p>
      </LegalSection>

      <LegalSection title="Service availability">
        <p>
          We aim to keep Chaap available, including offline at the gate, but we don&apos;t guarantee it will
          always be error-free or uninterrupted. Third parties we depend on — payment networks, SMS/WhatsApp
          delivery, our hosting providers — can and occasionally will have outages outside our control.
        </p>
      </LegalSection>

      <LegalSection title="Disclaimers and limitation of liability">
        <p>
          Chaap is provided &ldquo;as is.&rdquo; To the extent the law allows, we disclaim warranties beyond what
          we explicitly state, and our liability to you for any claim related to Chaap is limited to the amount
          you paid us, if any, in the{" "}
          <Placeholder>[time period, e.g. &ldquo;3 months&rdquo;]</Placeholder> before the claim arose.{" "}
          <Placeholder>
            [Have a lawyer review and tailor this whole section — limitation-of-liability clauses are highly
            jurisdiction-specific; this paragraph is a placeholder structure, not legal advice.]
          </Placeholder>
        </p>
      </LegalSection>

      <LegalSection title="Indemnity">
        <p>
          If you organize events, sell as a vendor, or sponsor on Chaap, you agree to cover reasonable costs we
          face from a third-party claim caused by your event, your listing, or your breach of these Terms.
        </p>
      </LegalSection>

      <LegalSection title="Ending your account">
        <p>
          You can delete your account at any time from Account → Settings (see our{" "}
          <a href="/privacy">Privacy Policy</a> for what that does). We can suspend or terminate your access if you
          seriously or repeatedly breach these Terms.
        </p>
      </LegalSection>

      <LegalSection title="Governing law">
        <p>
          These Terms are governed by the laws of the United Republic of Tanzania.{" "}
          <Placeholder>[Confirm the dispute-resolution process — courts vs. arbitration, and venue — with a lawyer.]</Placeholder>
        </p>
      </LegalSection>

      <LegalSection title="Changes to these terms">
        <p>
          We may update these Terms as Chaap grows; we&apos;ll update the effective date above, and tell you
          directly about a material change.
        </p>
      </LegalSection>

      <LegalSection title="Contact us">
        <p>
          Questions about these Terms? Reach us through Support in your Chaap account, or email{" "}
          <Placeholder>[support contact email]</Placeholder>.
        </p>
      </LegalSection>
    </LegalDocument>
  );
}
