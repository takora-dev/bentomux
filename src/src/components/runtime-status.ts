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

export function runtimeIcon(runtime: string): HTMLElement {
  const name = runtimeType(runtime);
  const key = name.toLowerCase();
  const agentLogos: Record<string, string> = {
    antigravity,
    amp,
    grok,
    cline,
    qoder,
    muse,
    kimi,
    kiro,
    pi,
    opencode,
    devin,
    cursor,
    hermes,
    agy: antigravity,
    qodercli: qoder,
    'hermes-agent': hermes,
    hermesagent: hermes,
  };
  const logo = agentLogos[key] ?? (key.includes('claude') || key.includes('anthropic') ? claude
    : key.includes('codex') || key.includes('openai') ? openai
    : key.includes('gemini') ? gemini
    : key.includes('copilot') ? copilot
    : key.includes('deepseek') ? deepseek
    : key.includes('qwen') ? qwen
    : key.includes('ollama') ? ollama
    : key.includes('mistral') ? mistral : null);
  // Unknown providers use the existing neutral glyph, not a fabricated brand.
  return markup('span', { class: 'runtime-icon', title: name, 'aria-label': name }, logo ?? (name === 'shell' ? IC.term : IC.diamond));
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
