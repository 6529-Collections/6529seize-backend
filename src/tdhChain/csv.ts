/**
 * A strict RFC 4180 reader: comma-separated fields, records ended by LF or
 * CRLF, a field quoted only from its first character, a quote inside it
 * written twice. Anything else (a stray quote, text after a closing quote,
 * an unclosed quote) is an error naming the line. One trailing line ending
 * is allowed; empty records are not.
 */
export class CsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CsvError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let line = 1;
  let i = 0;
  const n = text.length;
  let atFieldStart = true;
  while (i < n) {
    const c = text[i];
    if (atFieldStart && c === '"') {
      i++;
      let closed = false;
      while (i < n) {
        const q = text[i];
        if (q === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        if (q === '\n') line++;
        field += q;
        i++;
      }
      if (!closed) throw new CsvError(`line ${line}: unclosed quote`);
      const next = text[i];
      if (i < n && next !== ',' && next !== '\n' && next !== '\r') {
        throw new CsvError(`line ${line}: text after a closing quote`);
      }
      atFieldStart = false;
      continue;
    }
    if (c === ',') {
      record.push(field);
      field = '';
      atFieldStart = true;
      i++;
      continue;
    }
    if (c === '\r' || c === '\n') {
      if (c === '\r') {
        if (text[i + 1] !== '\n') {
          throw new CsvError(`line ${line}: a carriage return without LF`);
        }
        i++;
      }
      record.push(field);
      if (record.length === 1 && record[0] === '') {
        throw new CsvError(`line ${line}: empty record`);
      }
      records.push(record);
      record = [];
      field = '';
      atFieldStart = true;
      line++;
      i++;
      continue;
    }
    if (c === '"') throw new CsvError(`line ${line}: a quote inside a field`);
    field += c;
    atFieldStart = false;
    i++;
  }
  if (!atFieldStart || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

/** Quote a field when it needs it, as json-2-csv and RFC 4180 do. */
export function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
