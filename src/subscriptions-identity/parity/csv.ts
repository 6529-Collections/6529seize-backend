const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

/**
 * A small RFC 4180 reader for the published final-list files: comma
 * separated, fields optionally in double quotes, quotes doubled inside.
 * Returns one object per data row, keyed by the header row.
 */
export function parseCsv(text: string): Record<string, string>[] {
  const body = text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text;
  const records = readRecords(body);
  if (records.length === 0) {
    return [];
  }
  const header = records[0];
  return records.slice(1).map((record) => {
    if (record.length !== header.length) {
      throw new Error(
        `CSV row has ${record.length} fields, header has ${header.length}`
      );
    }
    const row: Record<string, string> = {};
    header.forEach((name, index) => {
      row[name] = record[index];
    });
    return row;
  });
}

class RecordReader {
  readonly records: string[][] = [];
  private record: string[] = [];
  private field = '';
  // A line with no characters is skipped; a line with a quoted empty field is not.
  private sawContent = false;

  addChar(c: string) {
    this.field += c;
    this.sawContent = true;
  }

  openQuote() {
    this.sawContent = true;
  }

  endField() {
    this.record.push(this.field);
    this.field = '';
    this.sawContent = true;
  }

  endRecord() {
    if (this.sawContent) {
      this.record.push(this.field);
      this.records.push(this.record);
    }
    this.record = [];
    this.field = '';
    this.sawContent = false;
  }

  get fieldIsEmpty(): boolean {
    return this.field === '';
  }
}

function readRecords(text: string): string[][] {
  const reader = new RecordReader();
  let quoted = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        reader.addChar('"');
        i += 2;
        continue;
      }
      if (c === '"') {
        quoted = false;
      } else {
        reader.addChar(c);
      }
    } else if (c === '"' && reader.fieldIsEmpty) {
      quoted = true;
      reader.openQuote();
    } else if (c === ',') {
      reader.endField();
    } else if (c === '\n' || c === '\r') {
      reader.endRecord();
      if (c === '\r' && text[i + 1] === '\n') {
        i++;
      }
    } else {
      reader.addChar(c);
    }
    i++;
  }
  if (quoted) {
    throw new Error('CSV ends inside a quoted field');
  }
  reader.endRecord();
  return reader.records;
}
