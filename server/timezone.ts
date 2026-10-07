// Shared with the browser; use named zones so daylight-saving changes are handled.
export function validTimeZone(value: string | null | undefined): string | null {
  if (!value || value.length > 100) return null;
  try {
    return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}
export function displayTimeZone(requestUrl: string, fallback?: string): string {
  return (
    validTimeZone(new URL(requestUrl).searchParams.get('tz')) ?? validTimeZone(fallback) ?? 'UTC'
  );
}
