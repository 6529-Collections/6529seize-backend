/**
 * A strict RFC 4180 CSV reader: comma separator, double-quote quoting with
 * doubled quotes as escapes, CRLF or LF row ends. Synchronous and
 * dependency-free so the build stays a pure function.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 2;
        continue;
      }
      if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
      i++;
      continue;
    }
    if (char === '"' && field === '') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      if (char === '\r' && text[i + 1] === '\n') {
        i++;
      }
    } else {
      field += char;
    }
    i++;
  }
  if (inQuotes) {
    throw new Error('Unterminated quoted CSV field');
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
