import { callClaude } from "./claude";

export type SurveySummaryResult =
  | { ok: true; summary: string }
  | { ok: false; reason: "NOT_CONFIGURED" | "REQUEST_FAILED" | "TOO_FEW_RESPONSES"; message: string };

const MIN_RESPONSES_TO_SUMMARIZE = 3;

// Guard: skip the API call entirely below the threshold — avoids spending a
// call summarizing 1-2 raw strings (the organizer can just read them), and
// sidesteps summarizing what might be a single respondent's answer.
export async function summarizeSurveyTheme(label: string, values: string[]): Promise<SurveySummaryResult> {
  if (values.length < MIN_RESPONSES_TO_SUMMARIZE) {
    return { ok: false, reason: "TOO_FEW_RESPONSES", message: "Not enough responses yet to summarize." };
  }

  const result = await callClaude({
    system:
      "You summarize open-ended survey responses for an event organizer. " +
      "Identify the 2-4 most common themes in 2-4 short sentences of plain " +
      "text — no markdown, no bullet points, no headers.",
    prompt: `Question: "${label}"\n\nResponses:\n${values.map((v) => `- ${v}`).join("\n")}`,
    maxTokens: 400,
  });
  if (!result.ok) return result;
  return { ok: true, summary: result.text.trim() };
}
