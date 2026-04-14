// Parse bracketed timestamp like [10:00:01.123] into a stable numeric value (ms).

const TS_RE = /^\[(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?\]/;

export function parseTimestamp(line: string): number | null {
  const m = line.match(TS_RE);
  if (!m) return null;
  const [, hh, mm, ss, ms = "0"] = m as unknown as [string, string, string, string, string];
  return (
    Number(hh) * 3_600_000 +
    Number(mm) * 60_000 +
    Number(ss) * 1_000 +
    Number(ms.padEnd(3, "0"))
  );
}

export function stripTimestamp(line: string): string {
  return line.replace(TS_RE, "").trimStart();
}
