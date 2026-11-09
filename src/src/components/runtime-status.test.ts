import { describe, it, expect } from 'vitest';
import { runtimeType, runtimeName, activityStatus, runtimeIcon, runtimeMetadata, statusIndicator } from './runtime-status';

describe('runtime identity and activity', () => {
  it('names sessions by runtime rather than workspace or branch', () => {
    expect(runtimeName(null)).toBe('Terminal');
    expect(runtimeName('shell')).toBe('Terminal');
    expect(runtimeName('claude')).toBe('Claude Code');
    expect(runtimeName('claude-code')).toBe('Claude Code');
    expect(runtimeName('codex')).toBe('Codex');
    expect(runtimeName('gemini')).toBe('Gemini');
    expect(runtimeName('custom-agent')).toBe('custom-agent');
  });
  it('treats absent and shell runtimes as shell without activity', () => {
    for (const raw of [null, undefined, '', 'shell', ' Shell ']) {
      const type = runtimeType(raw);
      expect(type).toBe('shell');
      expect(activityStatus(type, 'working')).toBeNull();
    }
  });
  it('does not infer working from a detected live agent', () => {
    expect(activityStatus('claude', null)).toBe('idle');
    expect(activityStatus('codex', undefined)).toBe('idle');
    expect(activityStatus('claude', 'working')).toBe('working');
  });
  it('maps approval blocks to waiting, and preserves explicit activity', () => {
    expect(activityStatus('claude', 'blocked')).toBe('waiting');
    for (const state of ['idle', 'working', 'thinking', 'waiting', 'error'] as const) {
      expect(activityStatus('custom-agent', state)).toBe(state);
      expect(statusIndicator(state).classList.contains(state)).toBe(true);
    }
  });
  it('uses provider logos and the Lucide terminal for shell', () => {
    expect(runtimeIcon('claude-code').innerHTML).toContain('viewBox="0 0 24 24"');
    expect(runtimeIcon('codex').innerHTML).not.toBe(runtimeIcon('shell').innerHTML);
    expect(runtimeIcon('claude-code').innerHTML).not.toBe(runtimeIcon('codex').innerHTML);
    expect(runtimeIcon('shell').querySelector('svg')?.getAttribute('stroke')).toBe('currentColor');
  });
  it('uses bundled LobeHub marks for additional detected agents', () => {
    const fallback = runtimeIcon('unlisted-agent').innerHTML;
    for (const agent of ['amp', 'antigravity', 'agy', 'cline', 'cursor', 'devin', 'grok', 'hermes', 'hermes-agent', 'kimi', 'kiro', 'muse', 'opencode', 'pi', 'qodercli']) {
      const icon = runtimeIcon(agent);
      expect(icon.querySelector('svg')).not.toBeNull();
      expect(icon.innerHTML).not.toBe(fallback);
    }
    expect(runtimeIcon('agy').innerHTML).toBe(runtimeIcon('antigravity').innerHTML);
    expect(runtimeIcon('qodercli').innerHTML).toBe(runtimeIcon('qoder').innerHTML);
    expect(runtimeIcon('hermes-agent').innerHTML).toBe(runtimeIcon('hermes').innerHTML);
  });
  it('never renders a status indicator or idle label for shell', () => {
    const el = runtimeMetadata('shell', activityStatus('shell', 'idle'), null);
    expect(el.textContent).toBe('Shell');
    expect(el.querySelector('.agent-status')).toBeNull();
    expect(el.querySelector('.workspace-branch')).toBeNull();
    expect(el.querySelector('.agent-sep')).toBeNull();
  });
  it('keeps branch in metadata and omits missing branches', () => {
    const el = runtimeMetadata('claude', 'idle', 'feature/long-branch');
    expect(el.querySelector('.agent-status')?.textContent).toBe('Idle');
    expect(el.querySelector('.branch-name')?.textContent).toBe('feature/long-branch');
    expect(el.querySelector('.metadata-git-icon svg')).not.toBeNull();
    expect(runtimeMetadata('codex', 'idle', '  ').querySelector('.workspace-branch')).toBeNull();
    expect(runtimeMetadata('codex', 'idle', 'a1b2c3d').querySelector('.branch-name')?.textContent).toBe('a1b2c3d');
  });
  it('renders branch and runtime strings as text, not HTML', () => {
    const el = runtimeMetadata('<img onerror=alert(1)>', 'idle', '<script>bad</script>');
    expect(el.querySelector('script')).toBeNull();
    expect(el.querySelector('.branch-name')?.textContent).toBe('<script>bad</script>');
  });
});
