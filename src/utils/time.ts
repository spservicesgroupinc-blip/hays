/**
 * Renders a stored timestamp for the field.
 *
 * The API writes ISO-8601 instants, while rows created by the legacy Sheets UI
 * hold a local `yyyy-MM-dd HH:mm:ss` string. Both parse cleanly, and anything
 * unparseable is shown verbatim instead of "Invalid Date".
 */
export function formatWhen(value?: string, fallback = 'Not recorded'): string {
  const parsed = parseStamp(value);
  if (!parsed) return String(value || '').trim() || fallback;
  return parsed.toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

/** Compact "Aug 4, 14:20" rendering for cards, timelines and badges. */
export function formatClock(value?: string, fallback = ''): string {
  const parsed = parseStamp(value);
  if (!parsed) return String(value || '').trim() || fallback;
  return parsed.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

/** `HH:MM` only, for same-day activity rows. */
export function formatTimeOnly(value?: string, fallback = ''): string {
  const parsed = parseStamp(value);
  if (!parsed) return String(value || '').trim() || fallback;
  return parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function parseStamp(value?: string): Date | null {
  const text = String(value || '').trim();
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
