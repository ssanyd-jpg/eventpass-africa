// Groups a form into labeled sections (Polish Session C) — a long flat
// stack of fields with no headers reads as one undifferentiated wall on
// mobile; a section title plus a divider gives the eye somewhere to land.
export function FormSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-t border-border pt-6 first:mt-0 first:border-t-0 first:pt-0">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">{title}</h2>
      {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
      <div className="mt-3 space-y-4">{children}</div>
    </div>
  );
}
