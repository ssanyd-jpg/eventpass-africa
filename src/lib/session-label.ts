// Hand-rolled, not a real UA parser — matches this codebase's established
// preference (Airpay checksum, CSV encoding) for a few substring checks over
// a new dependency. Good enough for a human-readable "which login is this"
// label; not security-sensitive, never used for access control.
export function deriveSessionLabel(userAgent: string | null | undefined): string {
  if (!userAgent) return "Unknown device";

  let browser = "Unknown browser";
  // Order matters: Edge/Opera/CriOS/FxiOS UAs also contain the generic
  // Chrome/Firefox substrings, so those must be checked first. Safari is
  // checked last and requires "Version/" — Chrome's UA also contains
  // "Safari/" but never "Version/".
  if (userAgent.includes("Edg/")) browser = "Edge";
  else if (userAgent.includes("OPR/") || userAgent.includes("Opera")) browser = "Opera";
  else if (userAgent.includes("CriOS") || userAgent.includes("Chrome/")) browser = "Chrome";
  else if (userAgent.includes("FxiOS") || userAgent.includes("Firefox/")) browser = "Firefox";
  else if (userAgent.includes("Safari/") && userAgent.includes("Version/")) browser = "Safari";

  let os = "Unknown OS";
  if (userAgent.includes("iPhone") || userAgent.includes("iPad")) os = "iOS";
  else if (userAgent.includes("Android")) os = "Android";
  else if (userAgent.includes("Windows")) os = "Windows";
  else if (userAgent.includes("Mac OS X")) os = "Mac";
  else if (userAgent.includes("Linux")) os = "Linux";

  if (browser === "Unknown browser" && os === "Unknown OS") return "Unknown device";
  return `${browser} on ${os}`;
}
