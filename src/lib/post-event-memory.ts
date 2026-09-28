import { dictionaries, type Locale, type TranslationKey } from "@/lib/i18n";
import { formatCents } from "@/lib/format";

// Pure, DB-free message builder for the post-event WhatsApp "memory"
// message (see post-event-memory-data.ts for the Prisma layer that gathers
// the inputs below and runs the sweep). No React/useTranslation here — this
// runs server-side inside a sweep, not in a component — so interpolation
// re-implements useTranslation's own `{placeholder}` convention
// (src/lib/use-translation.ts) rather than importing that client hook.
function translate(locale: Locale, key: TranslationKey, vars?: Record<string, string | number>): string {
  const template = dictionaries[locale][key] ?? dictionaries.en[key] ?? key;
  if (!vars) return template;
  return Object.entries(vars).reduce((acc, [name, value]) => acc.replaceAll(`{${name}}`, String(value)), template as string);
}

function formatCheckInTime(date: Date, locale: Locale): string {
  return date.toLocaleTimeString(locale === "sw" ? "sw-TZ" : "en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
}

export interface BuildMemoryMessageInput {
  attendee: { name: string };
  event: { title: string };
  // null/undefined = omit that line entirely — see each field's comment.
  checkInTime?: Date | null;
  totalSpentCents?: number | null;
  vendorCount?: number | null;
  // Pre-formatted ("4h 22m 14s") by getAttendeeFinishTime — MARATHON only,
  // the caller decides eligibility, this just omits the line when absent.
  finishTime?: string | null;
  currency?: string;
  locale?: Locale;
}

// Builds the WhatsApp recap text. Every optional field is omitted
// gracefully (never "You spent TZS 0" / "You visited 0 vendors") — only the
// greeting, recap intro, website line, and closing are always present.
export function buildMemoryMessage(input: BuildMemoryMessageInput): string {
  const locale = input.locale ?? "en";
  const currency = input.currency ?? "TZS";
  const firstName = (input.attendee.name || "").trim().split(/\s+/)[0] || input.attendee.name;

  const lines: string[] = [
    translate(locale, "memory.greeting", { name: firstName }),
    "",
    translate(locale, "memory.recapIntro", { event: input.event.title }),
    "",
  ];

  if (input.checkInTime) {
    lines.push(translate(locale, "memory.checkedInAt", { time: formatCheckInTime(input.checkInTime, locale) }));
  }
  if (input.finishTime) {
    lines.push(translate(locale, "memory.finishedIn", { finishTime: input.finishTime }));
  }
  if (input.totalSpentCents && input.totalSpentCents > 0 && input.vendorCount && input.vendorCount > 0) {
    const key = input.vendorCount === 1 ? "memory.spentAtVendor" : "memory.spentAtVendors";
    lines.push(translate(locale, key, { amount: formatCents(input.totalSpentCents, currency), vendorCount: input.vendorCount }));
  }
  lines.push(translate(locale, "memory.website"));

  lines.push("");
  lines.push(translate(locale, "memory.thankYou", { event: input.event.title }));
  lines.push(translate(locale, "memory.seeYouNextTime"));

  return lines.join("\n");
}
