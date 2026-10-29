/**
 * CSV: read a data file into rows the automation can iterate.
 *
 * Hand-written rather than pulled from a package, for a reason that matters in a browser extension: a
 * dependency is code the user has to trust and that a store reviewer has to inspect. A correct RFC 4180
 * reader is about a hundred lines, and writing it means quoting, embedded newlines and BOM handling are
 * testable directly.
 *
 * The cases that actually break naive parsers, and are covered in the tests:
 *   - a quoted field containing a comma
 *   - a quoted field containing a newline
 *   - escaped quotes ("")
 *   - a UTF-8 BOM at the start (Excel writes one)
 *   - CRLF line endings (Excel writes those too)
 *   - a trailing newline, which must not produce an empty row
 *   - a semicolon or tab delimiter, which European Excel uses
 */

export class CsvError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CsvError';
  }
}

export const DELIMITERS = {
  comma: ',',
  semicolon: ';',
  tab: '\t',
  pipe: '|',
};

/**
 * Detect the delimiter by counting candidates in the first line, respecting quotes.
 *
 * Guessing from frequency alone gets `"a;b",c` wrong, so quotes are skipped.
 */
export function detectDelimiter(text) {
  const firstLine = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'));
  const counts = {};
  let inQuotes = false;
  for (const ch of firstLine) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && Object.values(DELIMITERS).includes(ch)) {
      counts[ch] = (counts[ch] || 0) + 1;
    }
  }
  let best = ',';
  let bestCount = 0;
  for (const [d, n] of Object.entries(counts)) {
    if (n > bestCount) {
      best = d;
      bestCount = n;
    }
  }
  return best;
}

/**
 * Parse CSV text into an array of rows (arrays of strings).
 *
 * @param {string} text
 * @param {{delimiter?: string, quote?: string}} [opts]
 * @returns {string[][]}
 */
export function parseCsv(text, opts = {}) {
  if (typeof text !== 'string') throw new CsvError('CSV input must be a string');
  let s = text;
  // Excel writes a UTF-8 BOM; left in place it becomes part of the first header name
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);

  const delimiter = opts.delimiter && opts.delimiter !== 'auto'
    ? (DELIMITERS[opts.delimiter] ?? opts.delimiter)
    : detectDelimiter(s);
  if (delimiter.length !== 1) throw new CsvError('delimiter must be a single character');
  const quote = opts.quote ?? '"';

  const rows = [];
  let row = [];
  let field = '';
  let i = 0;
  let inQuotes = false;
  let fieldWasQuoted = false;

  const endField = () => {
    // RFC 4180 says a quoted field is used verbatim; unquoted fields are trimmed, because a stray space
    // after a comma is almost always accidental and trimming it is what a user expects.
    row.push(fieldWasQuoted ? field : field.trim());
    field = '';
    fieldWasQuoted = false;
  };
  const endRow = () => {
    endField();
    // skip a row that is entirely empty (a trailing newline, or a blank line in the middle)
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };

  while (i < s.length) {
    const ch = s[i];

    if (inQuotes) {
      if (ch === quote) {
        if (s[i + 1] === quote) {
          field += quote; // escaped quote
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === quote && field.trim() === '') {
      // a quote opens a quoted field only at the start of one
      inQuotes = true;
      fieldWasQuoted = true;
      field = '';
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      endField();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      if (s[i + 1] === '\n') i += 1;
      endRow();
      i += 1;
      continue;
    }
    if (ch === '\n') {
      endRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }

  if (inQuotes) throw new CsvError('the file ends inside a quoted field - it looks truncated');
  if (field !== '' || row.length > 0) endRow();

  return rows;
}

/**
 * Turn parsed rows into objects using the first row as headers.
 *
 * Headers are de-duplicated and emptied ones get a positional name, because a `row.email` reference to a
 * blank header would otherwise be unresolvable and the template error would point at the wrong place.
 */
export function rowsToObjects(rows, { header = true } = {}) {
  if (!Array.isArray(rows)) throw new CsvError('rows must be an array');
  if (rows.length === 0) return { columns: [], rows: [] };

  let columns;
  let dataRows;
  if (header) {
    columns = rows[0].map((h, idx) => {
      const name = String(h ?? '').trim();
      return name || `column${idx + 1}`;
    });
    dataRows = rows.slice(1);
  } else {
    const width = Math.max(...rows.map((r) => r.length));
    columns = Array.from({ length: width }, (_, i) => `column${i + 1}`);
    dataRows = rows;
  }

  // de-duplicate: email, email -> email, email_2
  const seen = new Map();
  columns = columns.map((c) => {
    const key = c.toLowerCase();
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    return n === 1 ? c : `${c}_${n}`;
  });

  const objects = dataRows.map((r) => {
    const o = {};
    columns.forEach((c, i) => {
      o[c] = r[i] === undefined ? '' : String(r[i]);
    });
    return o;
  });

  return { columns, rows: objects };
}

/** One call: CSV text to columns plus row objects. */
export function readCsv(text, opts = {}) {
  const rows = parseCsv(text, opts);
  if (rows.length === 0) throw new CsvError('the file is empty');
  const { columns, rows: objects } = rowsToObjects(rows, opts);
  return { columns, rows: objects, rawRows: rows, delimiter: opts.delimiter ?? 'auto' };
}

// ---------------------------------------------------------------------------------------------
// writing
// ---------------------------------------------------------------------------------------------

/** Quote a value only when it needs it. */
export function csvEscape(value, delimiter = ',') {
  const s = value === null || value === undefined ? '' : String(value);
  const needsQuote =
    s.includes(delimiter) || s.includes('"') || s.includes('\n') || s.includes('\r') ||
    s !== s.trim();
  return needsQuote ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows, { columns, delimiter = ',' } = {}) {
  if (!Array.isArray(rows)) throw new CsvError('rows must be an array');
  const cols = columns ?? (rows.length ? Object.keys(rows[0]) : []);
  const lines = [];
  if (cols.length) lines.push(cols.map((c) => csvEscape(c, delimiter)).join(delimiter));
  for (const r of rows) {
    if (Array.isArray(r)) {
      lines.push(r.map((v) => csvEscape(v, delimiter)).join(delimiter));
    } else {
      lines.push(cols.map((c) => csvEscape(r?.[c], delimiter)).join(delimiter));
    }
  }
  return lines.join('\r\n');
}

/**
 * Substitute `{{column}}` style placeholders, used for a data-row source URL or a text template.
 *
 * Kept separate from the `${}` template engine on purpose: `{{ }}` is for column names in a file the user
 * pasted, `${ }` is for the automation's own variables. Mixing them makes both harder to reason about.
 */
export function fillRowTemplate(text, row) {
  if (typeof text !== 'string') return '';
  return text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (whole, name) => {
    const key = name.trim();
    if (row && Object.prototype.hasOwnProperty.call(row, key)) return String(row[key] ?? '');
    return whole;
  });
}
