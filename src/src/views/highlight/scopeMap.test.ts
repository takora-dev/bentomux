import { describe, it, expect } from 'vitest';
import { mapScopeToKind } from './scopeMap';

/* The diff view is the only place Shiki runs, and it hands back a scope stack
   per token. Getting this wrong is not a crash — it is a diff where a keyword
   and a variable are the same colour, which nobody reports as a bug and
   everybody notices. */
const scopes = (...names: string[]) => names.map(scopeName => ({ scopeName }));

describe('mapScopeToKind()', () => {
  it('maps the scopes a reader would name first', () => {
    expect(mapScopeToKind(scopes('source.ts', 'keyword.control.import.ts'))).toBe('kw');
    expect(mapScopeToKind(scopes('source.ts', 'entity.name.function.ts'))).toBe('fn');
    expect(mapScopeToKind(scopes('source.ts', 'entity.name.type.ts'))).toBe('type');
    expect(mapScopeToKind(scopes('source.ts', 'string.quoted.double.ts'))).toBe('str');
    expect(mapScopeToKind(scopes('source.ts', 'comment.line.double-slash.ts'))).toBe('cmt');
    expect(mapScopeToKind(scopes('source.ts', 'constant.numeric.ts'))).toBe('num');
    expect(mapScopeToKind(scopes('source.ts', 'variable.other.readwrite.ts'))).toBe('var');
  });

  it('lets a string parent win over the punctuation inside it', () => {
    /* a `"` is punctuation.definition.string.*, but colouring the quote
       differently from the text it wraps reads as a rendering bug */
    expect(mapScopeToKind(scopes(
      'source.ts', 'string.quoted.double.ts', 'punctuation.definition.string.begin.ts',
    ))).toBe('str');
  });

  it('lets a comment parent win over the punctuation inside it', () => {
    expect(mapScopeToKind(scopes(
      'source.ts', 'comment.block.ts', 'punctuation.definition.comment.ts',
    ))).toBe('cmt');
  });

  it('treats a raw markup block as string content', () => {
    expect(mapScopeToKind(scopes('text.html.markdown', 'markup.raw.block'))).toBe('str');
  });

  it('keeps tag brackets as punctuation, since the palette has no tag kind', () => {
    expect(mapScopeToKind(scopes('text.html.basic', 'punctuation.definition.tag.begin.html'))).toBe('punc');
  });

  it('falls back to a plain identifier for an unknown scope', () => {
    expect(mapScopeToKind(scopes('source.ts', 'some.unknown.scope'))).toBe('var');
    expect(mapScopeToKind([])).toBe('var');
  });

  it('matches a prefix on a dot boundary, not on a raw string prefix', () => {
    /* 'keywordish' must not be read as 'keyword' */
    expect(mapScopeToKind(scopes('keywordish.thing'))).toBe('var');
    expect(mapScopeToKind(scopes('keyword.thing'))).toBe('kw');
  });

  it('uses the outermost scope that matches when several do', () => {
    expect(mapScopeToKind(scopes('entity.name.function.ts', 'variable.other.ts'))).toBe('fn');
  });
});
