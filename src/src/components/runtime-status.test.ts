import { describe, it, expect } from 'vitest';
import { runtimeType, runtimeName, activityStatus, runtimeColor, runtimeIcon, runtimeMetadata, statusIndicator } from './runtime-status';

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
  it('resolves brand colors consistently with provider marks and aliases', () => {
    expect(runtimeColor('claude')).toBe('#D97757');
    expect(runtimeColor('codex')).toBe('var(--ink)');
    expect(runtimeColor('gemini')).toBe('#3186FF');
    for (const [alias, brand] of [
      [' Claude-Code ', 'claude'], ['anthropic', 'claude'],
      ['openai', 'codex'], ['gemini-cli', 'gemini'],
      ['github-copilot', 'copilot'], ['agy', 'antigravity'],
      ['qodercli', 'qoder'], ['hermes-agent', 'hermes'], ['hermesagent', 'hermes'],
    ]) {
      expect(runtimeColor(alias)).toBe(runtimeColor(brand));
      expect(runtimeIcon(alias).innerHTML).toBe(runtimeIcon(brand).innerHTML);
      expect(runtimeIcon(alias, true).innerHTML).toBe(runtimeIcon(brand, true).innerHTML);
    }
  });
  it('keeps monochrome brands theme-aware and unknown runtimes neutral', () => {
    for (const agent of ['codex', 'copilot', 'cursor', 'grok', 'ollama', 'opencode', 'pi', 'hermes', 'cline']) {
      expect(runtimeColor(agent)).toBe('var(--ink)');
    }
    for (const agent of ['shell', '', 'unlisted-agent', '<img onerror=alert(1)>', 'constructor']) {
      expect(runtimeColor(agent)).toBeNull();
    }
  });
  it('uses original color artwork only when selected', () => {
    for (const agent of ['amp', 'antigravity', 'claude', 'deepseek', 'devin', 'gemini', 'kimi', 'kiro', 'mistral', 'muse', 'qoder', 'qwen']) {
      const inactive = runtimeIcon(agent, false);
      const active = runtimeIcon(agent, true);
      expect(inactive.classList.contains('runtime-icon-color')).toBe(false);
      expect(active.classList.contains('runtime-icon-color')).toBe(true);
      expect(active.innerHTML).not.toBe(inactive.innerHTML);
      // The title accent must come from the actual artwork, not an invented hue.
      expect(active.innerHTML.toLowerCase()).toContain(runtimeColor(agent)?.toLowerCase());
    }
    expect(runtimeIcon('claude', true).querySelector('[fill="#D97757"]')).not.toBeNull();
  });
  it('preserves multicolor fills, gradients and their local definitions', () => {
    for (const agent of ['gemini', 'muse']) {
      const icon = runtimeIcon(agent, true);
      expect(icon.querySelector('linearGradient, radialGradient')).not.toBeNull();
      for (const part of icon.querySelectorAll('[fill^="url("]')) {
        const id = part.getAttribute('fill')?.match(/^url\(#(.+)\)$/)?.[1];
        expect(id).toBeDefined();
        expect(icon.querySelector(`[id="${id}"]`)).not.toBeNull();
      }
    }
    const antigravity = runtimeIcon('antigravity', true);
    expect(antigravity.querySelector('[fill="#FC413D"]')).not.toBeNull();
    expect(antigravity.querySelector('[fill="#00B95C"]')).not.toBeNull();
    const mistral = runtimeIcon('mistral', true);
    expect(mistral.querySelector('[fill="#FF8205"]')).not.toBeNull();
    expect(mistral.querySelector('[fill="#E10500"]')).not.toBeNull();
  });
  it('does not invent color variants for monochrome brands or shell', () => {
    for (const agent of ['codex', 'copilot', 'cursor', 'pi', 'hermes', 'shell', 'unlisted-agent']) {
      expect(runtimeIcon(agent, true).innerHTML).toBe(runtimeIcon(agent, false).innerHTML);
      expect(runtimeIcon(agent, true).classList.contains('runtime-icon-color')).toBe(false);
    }
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
