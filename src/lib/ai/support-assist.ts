import { callClaude } from "./claude";

export type DraftReplyResult =
  | { ok: true; draft: string }
  | { ok: false; reason: "NOT_CONFIGURED" | "REQUEST_FAILED"; message: string };

export async function draftSupportReply(
  ticket: { subject: string; body: string },
  replies: { body: string; isFromOrganizer: boolean }[]
): Promise<DraftReplyResult> {
  const thread = [
    `Buyer: ${ticket.body}`,
    ...replies.map((r) => `${r.isFromOrganizer ? "Organizer" : "Buyer"}: ${r.body}`),
  ].join("\n");

  const result = await callClaude({
    system:
      "You are drafting a reply as the event organizer to a support ticket on a " +
      "ticketing platform. Be helpful, concise, and professional. Output the " +
      "reply body only — no greeting boilerplate like 'Dear...' unless it reads " +
      "naturally, no markdown, no signature.",
    prompt: `Subject: ${ticket.subject}\n\n${thread}\n\nDraft the next reply from the organizer.`,
    maxTokens: 400,
  });
  if (!result.ok) return result;
  return { ok: true, draft: result.text.trim() };
}

export const SUPPORT_CATEGORIES = ["Billing", "Access/Tickets", "Event Info", "Technical", "Other"] as const;
export const SUPPORT_PRIORITIES = ["LOW", "MEDIUM", "HIGH"] as const;
export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number];
export type SupportPriority = (typeof SUPPORT_PRIORITIES)[number];

export type CategorizeResult =
  | { ok: true; category: SupportCategory; priority: SupportPriority }
  | { ok: false; reason: "NOT_CONFIGURED" | "REQUEST_FAILED" | "UNPARSEABLE"; message: string };

// Never trusts free-form model output for something that drives UI styling
// — the response must parse as EXACTLY "Category | Priority" with both
// values from the closed sets above, or this returns UNPARSEABLE rather
// than guessing/defaulting.
export async function categorizeSupportTicket(subject: string, body: string): Promise<CategorizeResult> {
  const result = await callClaude({
    system:
      `You classify support tickets for an event ticketing platform. Respond ` +
      `with EXACTLY one line in the form "Category | Priority" and nothing else. ` +
      `Category must be exactly one of: ${SUPPORT_CATEGORIES.join(", ")}. ` +
      `Priority must be exactly one of: ${SUPPORT_PRIORITIES.join(", ")}.`,
    prompt: `Subject: ${subject}\n\nBody: ${body}`,
    maxTokens: 30,
  });
  if (!result.ok) return result;

  const line = result.text.trim().split("\n")[0] ?? "";
  const [rawCategory, rawPriority] = line.split("|").map((s) => s.trim());
  const category = SUPPORT_CATEGORIES.find((c) => c === rawCategory);
  const priority = SUPPORT_PRIORITIES.find((p) => p === rawPriority);
  if (!category || !priority) {
    return { ok: false, reason: "UNPARSEABLE", message: `Claude returned an unexpected classification: "${line}"` };
  }
  return { ok: true, category, priority };
}
