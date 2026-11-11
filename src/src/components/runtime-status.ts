import { h, markup } from '../dom';
import { IC } from '../icons';
import claude from '../assets/runtime/claude.svg?raw';
import openai from '../assets/runtime/openai.svg?raw';
import gemini from '../assets/runtime/gemini.svg?raw';
import copilot from '../assets/runtime/githubcopilot.svg?raw';
import deepseek from '../assets/runtime/deepseek.svg?raw';
import qwen from '../assets/runtime/qwen.svg?raw';
import ollama from '../assets/runtime/ollama.svg?raw';
import mistral from '../assets/runtime/mistral.svg?raw';
import antigravity from '../assets/runtime/antigravity.svg?raw';
import amp from '../assets/runtime/amp.svg?raw';
import grok from '../assets/runtime/grok.svg?raw';
import cline from '../assets/runtime/cline.svg?raw';
import qoder from '../assets/runtime/qoder.svg?raw';
import muse from '../assets/runtime/muse.svg?raw';
import kimi from '../assets/runtime/kimi.svg?raw';
import kiro from '../assets/runtime/kiro.svg?raw';
import pi from '../assets/runtime/pi.svg?raw';
import opencode from '../assets/runtime/opencode.svg?raw';
import devin from '../assets/runtime/devin.svg?raw';
import cursor from '../assets/runtime/cursor.svg?raw';
import hermes from '../assets/runtime/hermes.svg?raw';
import claudeColor from '../assets/runtime/claude-color.svg?raw';
import geminiColor from '../assets/runtime/gemini-color.svg?raw';
import deepseekColor from '../assets/runtime/deepseek-color.svg?raw';
import qwenColor from '../assets/runtime/qwen-color.svg?raw';
import mistralColor from '../assets/runtime/mistral-color.svg?raw';
import antigravityColor from '../assets/runtime/antigravity-color.svg?raw';
import ampColor from '../assets/runtime/amp-color.svg?raw';
import qoderColor from '../assets/runtime/qoder-color.svg?raw';
import museColor from '../assets/runtime/muse-color.svg?raw';
import kimiColor from '../assets/runtime/kimi-color.svg?raw';
import kiroColor from '../assets/runtime/kiro-color.svg?raw';
import devinColor from '../assets/runtime/devin-color.svg?raw';

export type ActivityStatus = 'idle' | 'working' | 'thinking' | 'waiting' | 'error';

export function runtimeType(runtime: string | null | undefined): string {
  const name = runtime?.trim() || 'shell';
  return name.toLowerCase() === 'shell' ? 'shell' : name;
}

export function runtimeName(runtime: string | null | undefined): string {
  const type = runtimeType(runtime);
  const names: Record<string, string> = {
    shell: 'Terminal',
    claude: 'Claude Code',
    'claude-code': 'Claude Code',
    claude_code: 'Claude Code',
    codex: 'Codex',
    gemini: 'Gemini',
    'gemini-cli': 'Gemini',
    copilot: 'GitHub Copilot',
    'github-copilot': 'GitHub Copilot',
    pi: 'Pi',
    opencode: 'OpenCode',
    deepseek: 'DeepSeek',
    qwen: 'Qwen',
    ollama: 'Ollama',
    mistral: 'Mistral',
  };
  return names[type.toLowerCase()] ?? type;
}

/* Process presence identifies the runtime, never its activity. Missing activity
   is idle; only an explicit detector result can mark an agent working. */
export function activityStatus(runtime: string, state: string | null | undefined): ActivityStatus | null {
  if (runtimeType(runtime) === 'shell') return null;
  if (state === 'blocked') return 'waiting';
  if (state === 'working' || state === 'thinking' || state === 'waiting' || state === 'error') return state;
  return 'idle';
}

interface RuntimeBrand {
  logo: string;
  colorLogo?: string;
  color: string;
}

/* Active icons use the bundled upstream color artwork, including gradients.
   Title colors use a representative fill from that artwork. Brands without a
   color variant stay monochrome, with theme ink for light/dark visibility. */
const runtimeBrands: Record<string, RuntimeBrand> = {
  claude: { logo: claude, colorLogo: claudeColor, color: '#D97757' },
  openai: { logo: openai, color: 'var(--ink)' },
  gemini: { logo: gemini, colorLogo: geminiColor, color: '#3186FF' },
  copilot: { logo: copilot, color: 'var(--ink)' },
  deepseek: { logo: deepseek, colorLogo: deepseekColor, color: '#4D6BFE' },
  qwen: { logo: qwen, colorLogo: qwenColor, color: '#082DFF' },
  ollama: { logo: ollama, color: 'var(--ink)' },
  mistral: { logo: mistral, colorLogo: mistralColor, color: '#FA500F' },
  antigravity: { logo: antigravity, colorLogo: antigravityColor, color: '#3186FF' },
  amp: { logo: amp, colorLogo: ampColor, color: '#F34E3F' },
  grok: { logo: grok, color: 'var(--ink)' },
  cline: { logo: cline, color: 'var(--ink)' },
  qoder: { logo: qoder, colorLogo: qoderColor, color: '#2ADB5C' },
  muse: { logo: muse, colorLogo: museColor, color: '#0082FB' },
  kimi: { logo: kimi, colorLogo: kimiColor, color: '#1783FF' },
  kiro: { logo: kiro, colorLogo: kiroColor, color: '#9046FF' },
  pi: { logo: pi, color: 'var(--ink)' },
  opencode: { logo: opencode, color: 'var(--ink)' },
  devin: { logo: devin, colorLogo: devinColor, color: '#0294DE' },
  cursor: { logo: cursor, color: 'var(--ink)' },
  hermes: { logo: hermes, color: 'var(--ink)' },
};

function runtimeBrand(runtime: string): RuntimeBrand | null {
  const key = runtimeType(runtime).toLowerCase();
  const aliases: Record<string, string> = {
    agy: 'antigravity',
    qodercli: 'qoder',
    'hermes-agent': 'hermes',
    hermesagent: 'hermes',
  };
  const brand = aliases[key] ?? (key.includes('claude') || key.includes('anthropic') ? 'claude'
    : key.includes('codex') || key.includes('openai') ? 'openai'
    : ['gemini', 'copilot', 'deepseek', 'qwen', 'ollama', 'mistral'].find(name => key.includes(name)) ?? key);
  return Object.hasOwn(runtimeBrands, brand) ? runtimeBrands[brand] : null;
}

export function runtimeColor(runtime: string): string | null {
  return runtimeBrand(runtime)?.color ?? null;
}

export function runtimeIcon(runtime: string, active: boolean = false): HTMLElement {
  const name = runtimeType(runtime);
  const brand = runtimeBrand(runtime);
  const colorLogo = active ? brand?.colorLogo : null;
  // Unknown providers use the existing neutral glyph, not a fabricated brand.
  return markup('span', {
    class: 'runtime-icon' + (colorLogo ? ' runtime-icon-color' : ''),
    title: name,
    'aria-label': name,
  }, colorLogo ?? brand?.logo ?? (name === 'shell' ? IC.term : IC.diamond));
}

export function statusIndicator(status: ActivityStatus): HTMLElement {
  const label = status[0].toUpperCase() + status.slice(1);
  return h('span', { class: 'agent-status ' + status, 'aria-label': 'Agent ' + label },
    h('span', { class: 'agent-status-label' }, label));
}

export function runtimeMetadata(runtime: string, status: ActivityStatus | null, gitBranch: string | null): HTMLElement {
  const branch = gitBranch?.trim();
  const el = h('span', { class: 'workspace-agent' },
    status ? statusIndicator(status) : h('span', { class: 'shell-label' }, 'Shell'));
  if (branch) el.append(
    h('span', { class: 'agent-sep', 'aria-hidden': 'true' }, '·'),
    h('span', { class: 'workspace-branch', title: branch },
      markup('span', { class: 'metadata-git-icon' }, IC.git),
      h('span', { class: 'branch-name' }, branch)));
  el.dataset.runtime = runtime;
  return el;
}
