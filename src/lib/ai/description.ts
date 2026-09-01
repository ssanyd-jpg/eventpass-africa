import { callClaude, type ClaudeCallResult } from "./claude";

export interface DescriptionDraftInput {
  title: string;
  category: string;
  venue: string;
  city: string;
  // Optional — an organizer may click "Draft with AI" before picking a
  // date/time on the create-event form.
  startsAt?: string;
}

export type DescriptionDraftResult =
  | { ok: true; description: string }
  | { ok: false; reason: "NOT_CONFIGURED" | "REQUEST_FAILED"; message: string };

export async function draftEventDescription(input: DescriptionDraftInput): Promise<DescriptionDraftResult> {
  const dateLine = input.startsAt ? `Date: ${input.startsAt}\n` : "";
  const result: ClaudeCallResult = await callClaude({
    system:
      "You write concise, upbeat event descriptions for a Tanzanian ticketing " +
      "platform. Output 2-4 sentences of plain text only — no markdown, no " +
      "headers, no quotation marks around the output, no placeholder text " +
      "like '[insert detail]'.",
    prompt: `Event: "${input.title}"\nCategory: ${input.category}\nVenue: ${input.venue}, ${input.city}\n${dateLine}\nWrite a description.`,
    maxTokens: 300,
  });
  if (!result.ok) return result;
  return { ok: true, description: result.text.trim() };
}
