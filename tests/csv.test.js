/**
 * CSV tests.
 *
 * Every test here is a real file someone will actually import: exported from Excel, saved by Numbers, or
 * pasted out of a Google Sheet. The quoting cases are the ones that break naive parsers.
 */
import { describe, it, expect } from 'vitest';
import {
  parseCsv, readCsv, rowsToObjects, detectDelimiter, csvEscape, toCsv, fillRowTemplate, CsvError,
} from '../src/core/io/csv.js';

describe('parseCsv — basics', () => {
  it('parses a simple file', () => {
    expect(parseCsv('a,b,c\n1,2,3')).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
  });

  it('handles CRLF because Excel writes it', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('strips a UTF-8 BOM so the first header is not corrupted', () => {
    // Left in place, the first header becomes "\uFEFFemail" and ${email} silently resolves to nothing.
    const withBom = '\uFEFFemail,name\nx@y.z,Ann';
    const { columns } = readCsv(withBom);
    expect(columns[0]).toBe('email');
  });

  it('ignores a trailing newline instead of producing an empty row', () => {
    expect(parseCsv('a,b\n1,2\n')).toHaveLength(2);
    expect(parseCsv('a,b\n1,2\n\n')).toHaveLength(2);
  });

  it('trims unquoted whitespace but not quoted content', () => {
    expect(parseCsv('a , b\n 1 , 2 ')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseCsv('"a ", " b"')).toEqual([['a ', ' b']]);
  });
});

describe('parseCsv — quoting', () => {
  it('keeps a comma inside quotes', () => {
    expect(parseCsv('a,b\n"x,y",z')).toEqual([['a', 'b'], ['x,y', 'z']]);
  });

  it('keeps a newline inside quotes', () => {
    const rows = parseCsv('a,b\n"line1\nline2",z');
    expect(rows).toHaveLength(2);
    expect(rows[1][0]).toBe('line1\nline2');
  });

  it('unescapes doubled quotes', () => {
    expect(parseCsv('a\n"he said ""hi"""')).toEqual([['a'], ['he said "hi"']]);
  });

  it('handles an empty quoted field', () => {
    expect(parseCsv('a,b,c\n"",x,""')).toEqual([['a', 'b', 'c'], ['', 'x', '']]);
  });

  it('reports a truncated file rather than guessing', () => {
    expect(() => parseCsv('a,b\n"unclosed,x')).toThrow(CsvError);
    expect(() => parseCsv('a,b\n"unclosed,x')).toThrow(/ends inside a quoted field/);
  });

  it('treats a quote in the middle of a field as literal text', () => {
    // a stray inch mark must not swallow the rest of the file
    expect(parseCsv('a\n5" pipe')).toEqual([['a'], ['5" pipe']]);
  });
});

describe('detectDelimiter', () => {
  it('finds a comma', () => {
    expect(detectDelimiter('a,b,c\n1,2,3')).toBe(',');
  });
  it('finds a semicolon, which European Excel uses', () => {
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
  });
  it('finds a tab', () => {
    expect(detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
  });
  it('is not fooled by delimiters inside quotes', () => {
    expect(detectDelimiter('"a;b",c,d\n1,2,3')).toBe(',');
  });
  it('parses with a chosen delimiter', () => {
    expect(readCsv('a;b\n1;2', { delimiter: 'semicolon' }).rows).toEqual([{ a: '1', b: '2' }]);
  });
});

describe('rowsToObjects', () => {
  it('uses the first row as headers', () => {
    const { columns, rows } = readCsv('email,name\nx@y.z,Ann');
    expect(columns).toEqual(['email', 'name']);
    expect(rows).toEqual([{ email: 'x@y.z', name: 'Ann' }]);
  });

  it('names empty headers positionally', () => {
    const { columns } = readCsv('email,,phone\n1,2,3');
    expect(columns).toEqual(['email', 'column2', 'phone']);
  });

  it('de-duplicates repeated headers', () => {
    const { columns } = readCsv('email,email\n1,2');
    expect(columns).toEqual(['email', 'email_2']);
  });

  it('pads a short row rather than leaving keys undefined', () => {
    const { rows } = readCsv('a,b,c\n1,2');
    expect(rows[0]).toEqual({ a: '1', b: '2', c: '' });
  });

  it('can read a headerless file', () => {
    const { columns, rows } = readCsv('1,2,3\n4,5,6', { header: false });
    expect(columns).toEqual(['column1', 'column2', 'column3']);
    expect(rows[0]).toEqual({ column1: '1', column2: '2', column3: '3' });
  });

  it('rejects an empty file', () => {
    expect(() => readCsv('')).toThrow(/empty/);
  });
});

describe('writing', () => {
  it('quotes only what needs quoting', () => {
    expect(csvEscape('plain')).toBe('plain');
    expect(csvEscape('has,comma')).toBe('"has,comma"');
    expect(csvEscape('has"quote')).toBe('"has""quote"');
    expect(csvEscape('line\nbreak')).toBe('"line\nbreak"');
    expect(csvEscape(' padded ')).toBe('" padded "');
    expect(csvEscape(null)).toBe('');
  });

  it('round-trips objects through CSV', () => {
    const rows = [{ a: 'x,y', b: 'plain' }, { a: 'q"q', b: 'z' }];
    const text = toCsv(rows);
    const back = readCsv(text, { delimiter: '\n' === text[0] ? ',' : ',' });
    expect(back.rows).toEqual(rows);
  });

  it('writes a header from the first object', () => {
    expect(toCsv([{ a: 1, b: 2 }])).toBe('a,b\r\n1,2');
  });
});

describe('fillRowTemplate', () => {
  it('substitutes column values', () => {
    expect(fillRowTemplate('Hello {{name}}!', { name: 'Ann' })).toBe('Hello Ann!');
  });
  it('tolerates spacing inside the braces', () => {
    expect(fillRowTemplate('{{ name }}', { name: 'Ann' })).toBe('Ann');
  });
  it('leaves an unknown placeholder alone so the mistake is visible', () => {
    expect(fillRowTemplate('{{missing}}', { name: 'Ann' })).toBe('{{missing}}');
  });
});
