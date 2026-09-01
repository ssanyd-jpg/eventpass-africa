// Hand-rolled Claude (Anthropic Messages API) client — no @anthropic-ai/sdk
// dependency, matching this codebase's preference for hand-rolling a single
// well-understood HTTP integration over pulling in a library for one use
// case (see src/lib/csv.ts's header comment, src/lib/payments/airpay.ts's
// postForm()). Every AI feature in this codebase (event description drafts,
// support reply drafts/categorization, survey summaries) goes through this
// one module — same "single choke point" discipline as sendNotification()
// in src/lib/notifications.ts, so only this file changes if the provider or
// model ever changes.

const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

// Haiku, not Sonnet/Opus — every call site here is a short, low-stakes
// generative task (draft a description, draft a reply, categorize a
// ticket, summarize a handful of survey answers), not agentic/coding work.
// Cheap and fast matters more than maximum capability for a cost-sensitive
// Tanzania-market ticketing platform. Override per-call only if a specific
// feature's output quality demands it.
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

export function isClaudeConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

export interface ClaudeCallInput {
  system: string;
  prompt: string;
  maxTokens?: number;
  model?: string;
}

export type ClaudeCallResult =
  | { ok: true; text: string }
  | { ok: false; reason: "NOT_CONFIGURED" | "REQUEST_FAILED"; message: string };

// Single call point — one system prompt, one user turn, plain text back. No
// tool use, no streaming, no multi-turn: every feature in this pass is a
// single request/response. If a future feature needs multi-turn, extend the
// signature then — don't speculatively build it now.
export async function callClaude(input: ClaudeCallInput): Promise<ClaudeCallResult> {
  if (!isClaudeConfigured()) {
    return { ok: false, reason: "NOT_CONFIGURED", message: "ANTHROPIC_API_KEY is not set on this deployment." };
  }

  let res: Response;
  try {
    res = await fetch(MESSAGES_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY!,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: input.model ?? DEFAULT_MODEL,
        max_tokens: input.maxTokens ?? 1024,
        system: input.system,
        messages: [{ role: "user", content: input.prompt }],
      }),
    });
  } catch (err) {
    return {
      ok: false,
      reason: "REQUEST_FAILED",
      message: err instanceof Error ? err.message : "Network error calling Claude.",
    };
  }

  const text = await res.text();
  if (!res.ok) {
    return { ok: false, reason: "REQUEST_FAILED", message: `Claude returned HTTP ${res.status}: ${text.slice(0, 300)}` };
  }

  let data: { content?: { type: string; text?: string }[] };
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, reason: "REQUEST_FAILED", message: `Claude returned a non-JSON response: ${text.slice(0, 300)}` };
  }

  const block = data.content?.find((b) => b.type === "text");
  if (!block?.text) {
    return { ok: false, reason: "REQUEST_FAILED", message: "Claude response had no text content." };
  }
  return { ok: true, text: block.text };
}
