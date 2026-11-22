/**
 * worker/utils/csv.ts — CSV escaping and formula injection neutralization
 * ─────────────────────────────────────────────────────────────────────────────
 * Complies with RFC 4180 and protects spreadsheet applications from formula injection.
 *
 * Rules:
 * 1. Neutralize formula injection: Any value that begins with =, +, -, @, tab (\t),
 *    or carriage return (\r) (after trimming leading horizontal whitespace)
 *    is prefixed with a single quote (').
 * 2. RFC 4180 Quoting: If the field contains a comma (,), double quote ("),
 *    newline (\n), or carriage return (\r), the entire field is enclosed in double quotes ("),
 *    and any inner double quotes are escaped by doubling them ("").
 */

export function escapeCsv(val: unknown): string {
  let str = val === null || val === undefined ? '' : String(val);

  // Check if string begins with =, +, -, @, \t, or \r after trimming leading whitespace
  const trimmedLeading = str.replace(/^[ \f\v]+/, '');
  if (/^[=+\-@\t\r]/.test(trimmedLeading)) {
    str = `'${str}`;
  }

  // RFC 4180: If field contains commas, double quotes, or line breaks, enclose in double quotes
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    str = `"${str.replace(/"/g, '""')}"`;
  }

  return str;
}
