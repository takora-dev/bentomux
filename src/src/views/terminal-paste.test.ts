import { describe, it, expect } from 'vitest';
import { cleanPastedText, formatPastedText } from './terminal';

describe('cleanPastedText()', () => {
  it('converts Windows CRLF and classic Mac CR to Unix LF', () => {
    expect(cleanPastedText('line 1\r\nline 2\rline 3')).toBe('line 1\nline 2\nline 3');
  });

  it('strips trailing newlines to prevent premature command submit', () => {
    expect(cleanPastedText('command with newline\n')).toBe('command with newline');
    expect(cleanPastedText('command with crlf\r\n')).toBe('command with crlf');
    expect(cleanPastedText('multiline text\r\nline 2\n\n\n')).toBe('multiline text\nline 2');
  });

  it('preserves leading and internal whitespace and line breaks', () => {
    const input = '  function foo() {\r\n    return 42;\r\n  }';
    expect(cleanPastedText(input)).toBe('  function foo() {\n    return 42;\n  }');
  });
});

describe('formatPastedText()', () => {
  it('wraps text in bracketed paste mode without carriage returns', () => {
    const input = 'Downloading https://github.com/...\r\n        Info validating hash\r\n';
    const formatted = formatPastedText(input, true);
    expect(formatted).toBe('\x1b[200~Downloading https://github.com/...\n        Info validating hash\x1b[201~');
    expect(formatted).not.toContain('\r');
  });

  it('formats plain text without bracketed markers when isBracketed is false', () => {
    const input = 'echo hello\r\n';
    expect(formatPastedText(input, false)).toBe('echo hello');
  });

  it('returns empty string for empty input', () => {
    expect(formatPastedText('', true)).toBe('');
    expect(formatPastedText('\r\n\n', true)).toBe('');
  });
});
