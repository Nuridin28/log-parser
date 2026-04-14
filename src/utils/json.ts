// Safe JSON extraction. Logs often carry a JSON object appended to a
// human-readable prefix: `Proxy Outgoing Request {"request":{...}}`.

export function safeParse(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

export function extractJson(message: string): Record<string, unknown> | null {
  const i = message.indexOf("{");
  if (i === -1) return null;
  for (let end = message.length; end > i; end--) {
    const slice = message.slice(i, end);
    const parsed = safeParse(slice);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  }
  return null;
}
