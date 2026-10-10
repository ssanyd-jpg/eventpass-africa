import type { ReactNode } from "react";

// A bracketed fact this draft can't know from the codebase alone (a
// registered legal entity name, a support address, a lawyer-reviewed
// clause) — rendered with a visible highlight so an unfinished draft never
// quietly reads as a finished policy, on the page itself and not just in
// the source.
export function Placeholder({ children }: { children: ReactNode }) {
  return <mark className="rounded bg-warn/20 px-1 py-0.5 font-medium text-warn">{children}</mark>;
}

// Shared chrome for the Privacy Policy and Terms of Service — same title/
// date/intro block, same section rhythm — so the two documents read as one
// pair rather than two differently-built pages.
export default function LegalDocument({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-3xl px-4 pb-20 pt-10 sm:px-6">
      <h1 className="font-display text-3xl font-extrabold tracking-tight sm:text-4xl">{title}</h1>
      <p className="mt-2 text-sm text-muted">
        Effective <Placeholder>[date you publish this page]</Placeholder>
      </p>
      <div className="mt-10 space-y-10">{children}</div>
    </div>
  );
}

export function LegalSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="font-display text-xl font-bold text-foreground">{title}</h2>
      <div className="mt-3 space-y-3 text-sm leading-relaxed text-muted [&_strong]:text-foreground [&_a]:text-accent-hover [&_a]:underline [&_a]:underline-offset-2">
        {children}
      </div>
    </section>
  );
}
