import type { BotCommand } from "./types.js";

const KNOWN: Record<string, BotCommand["kind"]> = {
  analyze: "analyze",
  review: "review",
  retry: "retry",
  status: "status",
  prism: "help",
  repos: "repos",
  repo: "repo",
  logs: "logs",
  scan: "scan",
  settings: "settings",
};

/**
 * Extracts a bot command from text. Per the design, a command must be the
 * first non-empty line and is ignored when inside code fences or a blockquote,
 * so a pasted issue or summarized chat history cannot trigger a side effect.
 * `/prism help` and `/prism` both map to the help command.
 */
export function parseBotCommand(text: string): BotCommand | null {
  let line = "";
  let inFence = false;
  let inQuote = false;
  let sawContent = false;

  for (const rawLine of text.split("\n")) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      if (!sawContent) line = "";
      continue;
    }
    if (!inFence && trimmed.startsWith(">")) {
      if (!sawContent) {
        inQuote = true;
        line = "";
      }
      continue;
    }
    if (inFence || inQuote) continue;
    if (trimmed.length > 0) {
      sawContent = true;
      line = trimmed;
      break;
    }
  }

  if (!sawContent || line.length === 0) return null;
  const [rawName, ...rest] = line.split(/\s+/);
  const name = rawName?.replace(/^\/+/, "").toLowerCase() ?? "";
  if (!Object.hasOwn(KNOWN, name)) return null;
  const kind = KNOWN[name];
  if (!kind) return null;
  const raw = rest.join(" ").trim();
  return { kind, raw: kind === "help" ? "" : raw };
}
