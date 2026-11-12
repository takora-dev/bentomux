/* ---------------- agents: picker + per-agent detail (4 sub-tabs) ----------------
   Master page (route `{ view: 'agents' }`) is a card grid of every supported
   agent runtime; clicking one enters the detail page
   (route `{ view: 'agentDetail', agentId, tab }`) which hosts four sub-tabs:
     Model   — picker that writes the agent's own config file
     Memory  — list + editor of memory items assigned to this agent
     Skills  — list + editor of skills assigned to this agent
     MCP     — list + editor of MCP servers assigned to this agent
   The detail header also carries a back button + a small "switch agent"
   affordance (re-enter the picker). */

import { h, markup } from '../dom';
import { ic, IC } from '../icons';
import { chipEl } from '../components/chip';
import { field } from '../components/modal';
import { selectEl } from '../components/select';
import { toggleSeg } from '../components/toggle';
import type {
  AgentConfigView, AgentInfo, ModelField, ModelSettingsPatch,
  ResourceItem, ResourceKind, ResourceSavePayload,
} from '../../shared/types';
import { db } from '../store';
import { go } from '../router';
import api from '../../preload/bentomux';

type SubTab = 'model' | 'memory' | 'skills' | 'mcp';

const SUB_TAB_LABELS: Record<SubTab, { title: string; singular: string; icon: 'chat' | 'lines' | 'board' | 'bot'; fieldLabel: string; lede: string }> = {
  model:  { title: 'Model',   singular: 'model',   icon: 'bot',    fieldLabel: 'Model',         lede: 'Configure the model this agent runs by default — custom ids, base URL, context window, API key, and API format.' },
  memory: { title: 'Memory',  singular: 'memory',  icon: 'chat',   fieldLabel: 'Content',       lede: 'Shared context for this agent.' },
  skills: { title: 'Skills',  singular: 'skill',   icon: 'lines',  fieldLabel: 'Instructions',  lede: 'Reusable instructions for this agent.' },
  mcp:    { title: 'MCP',     singular: 'MCP server', icon: 'board', fieldLabel: 'Configuration', lede: 'Local tool servers for this agent.' },
};

const NAME_MAX = 120;
const DEFAULT_MCP_BODY = '{\n  "command": "",\n  "args": [],\n  "env": {}\n}';
const MCP_PLACEHOLDER = '{"command":"npx","args":["-y","@example/mcp-server"],"env":{}}';

/* ============== master page: card grid ============== */

function capabilityPills(a: AgentInfo): HTMLElement[] {
  const items: HTMLElement[] = [];
  for (const k of ['memory', 'skills', 'mcp'] as const) {
    const supported = a.capabilities[k];
    const cls = 'pill' + (supported ? ' on' : ' off');
    items.push(h('span', { class: cls, title: supported ? SUB_TAB_LABELS[k].title + ' supported' : SUB_TAB_LABELS[k].title + ' not supported' },
      ic(SUB_TAB_LABELS[k].icon),
      h('span', {}, SUB_TAB_LABELS[k].title)));
  }
  return items;
}

function agentCard(a: AgentInfo, open: (info: AgentInfo, tab: SubTab) => void): HTMLElement {
  const detected = a.detected;
  return h('button', {
    class: 'agent-card' + (detected ? '' : ' off'),
    type: 'button',
    onclick: () => open(a, 'model'),
  },
    h('div', { class: 'agent-card-h' },
      markup('span', { class: 'agent-card-avatar' }, IC.bot),
      h('div', { class: 'agent-card-id' },
        h('b', {}, a.name),
        h('span', { class: 'agent-card-detect ' + (detected ? 'on' : 'off') },
          detected ? 'Detected' : 'Not detected'))),
    h('p', { class: 'agent-card-model' },
      a.currentModel
        ? h('span', {}, 'Model: ', h('code', {}, a.currentModel))
        : h('span', { class: 'muted' }, 'No model set')),
    h('div', { class: 'agent-card-pills' }, ...capabilityPills(a)),
    h('div', { class: 'agent-card-foot' },
      chipEl(a, { lg: true }),
      h('span', { class: 'agent-card-go' }, 'Configure →')));
}

export function agentsPage(): HTMLElement {
  const wrap = h('div', { class: 'page agents-page' });
  wrap.append(
    h('div', { class: 'page-head' },
      h('div', { class: 'grow' },
        h('h1', { class: 'pg' }, 'Agents'),
        h('p', { class: 'resource-lede' }, 'Detected AI runtimes. Click an agent to change its model or manage its Memory, Skills, and MCP servers.')),
      h('button', { class: 'btn ghost', onclick: () => void reload() }, 'Refresh')),
  );

  const grid = h('div', { class: 'agents-grid' },
    h('div', { class: 'empty-note' }, 'Detecting…'));
  wrap.append(grid);

  async function reload(): Promise<void> {
    grid.innerHTML = '';
    grid.append(h('div', { class: 'empty-note' }, 'Detecting…'));
    try {
      const list = await api.agents();
      grid.innerHTML = '';
      if (!list.length) {
        grid.append(h('div', { class: 'empty-note' }, 'No agents available.'));
        return;
      }
      grid.append(...list.map(a => agentCard(a, (info, tab) => go({ view: 'agentDetail', agentId: info.id, tab }))));
    } catch (e) {
      grid.innerHTML = '';
      grid.append(h('div', { class: 'empty-note' }, 'Failed to read agent registry.'));
      console.error(e);
    }
  }

  void reload();
  return wrap;
}

/* ============== detail page: header + sub-tabs ============== */

interface MemoryFields {
  scopeSel: HTMLButtonElement;
  wsSel: HTMLButtonElement;
  wsSelWrap: HTMLElement;
}

function buildMemoryFields(item: ResourceItem | null): MemoryFields {
  const scopeSel = selectEl([['global', 'Global'], ['project', 'Project']], item?.scope === 'project' ? 'project' : 'global');
  const wsSel = selectEl(db.workspaces.map(w => [w.id, w.name] as [string, string]), db.activeWorkspaceId || undefined);
  const wsSelWrap = field('Workspace', wsSel);
  wsSelWrap.style.display = (item?.scope === 'project') ? '' : 'none';
  scopeSel.addEventListener('change', () => {
    wsSelWrap.style.display = scopeSel.value === 'project' ? '' : 'none';
  });
  return { scopeSel, wsSel, wsSelWrap };
}

function bodyConfigFor(kind: ResourceKind, item: ResourceItem | null): { placeholder: string; value: string } {
  if (kind === 'memory') return { placeholder: 'What should the agent remember?', value: item?.content || '' };
  if (kind === 'skills') return { placeholder: 'Instructions the agent should follow.', value: item?.instructions || '' };
  return { placeholder: MCP_PLACEHOLDER, value: item?.configJson || DEFAULT_MCP_BODY };
}

function kindPayloadExtras(kind: ResourceKind, body: string, kindFields: MemoryFields | null): Partial<ResourceSavePayload> {
  if (kind === 'memory') {
    const { scopeSel, wsSel } = kindFields!;
    const scope: 'global' | 'project' = scopeSel.value === 'project' ? 'project' : 'global';
    return {
      scope,
      workspacePath: scope === 'project' ? (db.workspaces.find(w => w.id === wsSel.value)?.path ?? null) : null,
      content: body,
    };
  }
  if (kind === 'skills') return { instructions: body };
  return { configJson: body };
}

async function loadItemForEdit(kind: ResourceKind, id: string | undefined): Promise<ResourceItem | null> {
  if (!id) return null;
  const items = await api.listResources(kind);
  return items.find(x => x.id === id) || null;
}

function richEmpty(meta: { title: string; singular: string; icon: 'chat' | 'lines' | 'board' | 'bot' }, onCreate: () => void): HTMLElement {
  return h('div', { class: 'empty rich-empty' },
    markup('span', { class: 'empty-icon' }, IC[meta.icon]),
    h('p', { class: 'empty-title' }, 'No ' + meta.title.toLowerCase() + ' yet'),
    h('p', { class: 'empty-sub' }, 'Add the first ' + meta.singular + ' for this agent to see it here.'),
    h('button', { class: 'btn primary', onclick: onCreate }, '+ New ' + meta.singular));
}

function previewOf(kind: ResourceKind, item: ResourceItem): string {
  return kind === 'memory' ? item.content || '' : kind === 'skills' ? item.instructions || '' : item.configJson || '';
}

function resourceCard(kind: ResourceKind, item: ResourceItem, onToggle: (id: string, on: boolean) => void, onEdit: () => void): HTMLElement {
  const meta = SUB_TAB_LABELS[kind];
  const preview = previewOf(kind, item);
  const off = item.status === 'off';
  const card = h('button', { class: 'resource-card' + (off ? ' off' : ''), type: 'button', onclick: onEdit },
    h('div', { class: 'resource-card-head' },
      markup('span', { class: 'resource-icon' }, IC[meta.icon]),
      h('b', {}, item.name),
      h('span', { class: 'res-switch', onclick: (e: Event) => e.stopPropagation() }, activeSwitch(item, onToggle))),
    h('p', { class: 'resource-card-preview' }, preview));
  return card;
}

function resourceRow(kind: ResourceKind, item: ResourceItem, onToggle: (id: string, on: boolean) => void, onEdit: () => void): HTMLElement {
  const meta = SUB_TAB_LABELS[kind];
  const off = item.status === 'off';
  const row = h('div', {
    class: 'row res-row' + (off ? ' off' : ''), role: 'button', tabindex: '0',
    title: item.name, onclick: onEdit,
  },
    markup('span', { class: 'glyph' }, IC[meta.icon]),
    h('span', { class: 'row-title' }, item.name),
    h('span', { class: 'res-switch', onclick: (e: Event) => e.stopPropagation() }, activeSwitch(item, onToggle)));
  row.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onEdit(); }
  });
  return row;
}

function activeSwitch(item: ResourceItem, onToggle: (id: string, on: boolean) => void): HTMLElement {
  return toggleSeg(item.status !== 'off', on => onToggle(item.id, on), { labels: ['Inactive', 'Active'], tag: 'span' });
}

/* ============== sub-tab bodies ============== */

function buildModelTab(agentId: string, view: AgentConfigView, onApplied: (next: AgentConfigView) => void): HTMLElement {
  const body = h('div', { class: 'agent-tab-body' });
  const cur = view.modelSettings;
  if (!cur || !view.modelFields.length) {
    body.append(h('div', { class: 'agent-section-empty' },
      ic('lines'),
      h('span', {}, 'This agent does not expose editable model settings.')));
    return body;
  }
  const has = (f: ModelField): boolean => view.modelFields.includes(f);

  /* custom ids always allowed; known models arrive as datalist suggestions */
  const modelInput = h('input', {
    value: cur.model, placeholder: 'e.g. claude-sonnet-4-5',
    list: 'bentomux-model-suggestions',
  }) as HTMLInputElement;
  const datalist = h('datalist', { id: 'bentomux-model-suggestions' },
    ...view.modelSuggestions.map(s => h('option', { value: s })));

  const urlInput = h('input', { value: cur.baseUrl, placeholder: 'https://api.example.com/v1' }) as HTMLInputElement;
  const ctxInput = h('input', { value: cur.context, placeholder: 'e.g. 128000 or 128k' }) as HTMLInputElement;
  const keyInput = h('input', {
    type: 'password', autocomplete: 'off',
    placeholder: cur.hasApiKey ? 'Saved — leave blank to keep' : 'API key',
  }) as HTMLInputElement;
  const formatCtl: HTMLInputElement | HTMLButtonElement = view.modelFormats.length
    ? selectEl([['', '— default —'], ...view.modelFormats.map(f => [f.value, f.label] as [string, string])], cur.format || '')
    : h('input', { value: cur.format, placeholder: 'e.g. openai-completions' }) as HTMLInputElement;

  const fields = h('div', { class: 'agent-model-fields' },
    has('model') ? field('Model', modelInput) : null,
    has('baseUrl') ? field('Base URL', urlInput) : null,
    has('context') ? field('Context window', ctxInput) : null,
    has('apiKey') ? field('API key', keyInput) : null,
    has('format') ? field('API format', formatCtl) : null,
    h('p', { class: 'agent-section-hint' },
      view.modelWriteTarget
        ? h('span', {}, 'Apply writes to ', h('code', {}, view.modelWriteTarget))
        : h('span', { class: 'muted' }, 'No config path exposed')));

  const errLine = h('div', { class: 'agent-err', style: 'display:none' });
  const applyBtn = h('button', { class: 'btn primary', onclick: () => void apply() }, 'Apply') as HTMLButtonElement;

  async function apply(): Promise<void> {
    /* empty values clear the field; an untouched API-key box leaves the
       stored key alone — it is never echoed back to the renderer */
    const patch: ModelSettingsPatch = {};
    if (has('model')) patch.model = modelInput.value.trim();
    if (has('baseUrl')) patch.baseUrl = urlInput.value.trim();
    if (has('context')) patch.context = ctxInput.value.trim();
    if (has('format')) patch.format = formatCtl.value.trim();
    const key = keyInput.value.trim();
    if (key) patch.apiKey = key;

    applyBtn.textContent = 'Applying…';
    applyBtn.setAttribute('disabled', '');
    try {
      const next = await api.setAgentModelSettings(agentId, patch);
      errLine.style.display = 'none';
      onApplied(next);
    } catch (e: unknown) {
      applyBtn.textContent = 'Apply';
      applyBtn.removeAttribute('disabled');
      errLine.style.display = '';
      errLine.textContent = e instanceof Error ? e.message : String(e);
    }
  }

  body.append(
    h('p', { class: 'resource-lede' }, SUB_TAB_LABELS.model.lede),
    h('div', { class: 'agent-model-row' }, fields, applyBtn),
    datalist,
    errLine);
  return body;
}

function buildResourceTab(agentId: string, kind: ResourceKind, viewMode: 'cards' | 'list'): HTMLElement {
  const meta = SUB_TAB_LABELS[kind];
  const supported = (db.agents?.find(a => a.id === agentId)?.capabilities[kind]) ?? false;
  const wrap = h('div', { class: 'agent-tab-body resource-tab' });
  if (!supported) {
    wrap.append(h('div', { class: 'agent-section-empty' },
      ic(meta.icon),
      h('span', {}, meta.title + ' is not supported by this agent.')));
    return wrap;
  }

  /* two view modes: 'list' (toolbar + grid) and 'editor' (inline form).
     List switches to editor on add/edit; editor switches back on cancel/save/delete. */
  let mode: 'list' | 'editor' = 'list';
  let currentView: 'cards' | 'list' = viewMode;
  let allItems: ResourceItem[] = [];
  let editingId: string | null = null;
  let confirmDeleteMode = false;

  /* shared slot the two views repaint into */
  const slot = h('div', { class: 'resource-slot' });
  wrap.append(slot);

  /* ---- list view ---- */
  const grid = h('div', { class: currentView === 'cards' ? 'resource-grid' : 'resource-list' },
    h('div', { class: 'empty-note' }, 'Loading…'));
  const searchInput = buildSearchInput(meta);
  const seg = h('div', { class: 'seg' },
    h('button', { title: 'List view', onclick: () => setMode('list') }, markup('span', null, IC.lines), 'List'),
    h('button', { title: 'Card view', onclick: () => setMode('cards') }, markup('span', null, IC.board), 'Cards'));
  syncSeg(seg, currentView);
  const toolbar = h('div', { class: 'res-toolbar' },
    searchInput,
    seg,
    h('button', { class: 'btn primary', onclick: () => showEditor(null) }, '+ New ' + meta.singular));

  function paintList(): void {
    const q = searchInput.value.trim().toLowerCase();
    const visible = q
      ? allItems.filter(i => (i.name + ' ' + previewOf(kind, i)).toLowerCase().includes(q))
      : allItems;
    grid.className = currentView === 'cards' ? 'resource-grid' : 'resource-list';
    grid.innerHTML = '';
    if (!allItems.length) {
      grid.append(richEmpty(meta, () => showEditor(null)));
      return;
    }
    if (!visible.length) {
      grid.append(h('div', { class: 'empty-note' }, `No matches for “${searchInput.value.trim()}”.`));
      return;
    }
    grid.append(...visible.map(item =>
      currentView === 'cards' ? resourceCard(kind, item, toggleItem, () => showEditor(item.id)) : resourceRow(kind, item, toggleItem, () => showEditor(item.id))));
  }

  function showList(): void {
    mode = 'list';
    confirmDeleteMode = false;
    editingId = null;
    slot.innerHTML = '';
    slot.append(h('p', { class: 'resource-lede' }, meta.lede), toolbar, grid);
    paintList();
  }

  /* ---- editor view ---- */
  function showEditor(id: string | null): void {
    mode = 'editor';
    editingId = id;
    confirmDeleteMode = false;
    void loadAndPaintEditor();
  }

  async function loadAndPaintEditor(): Promise<void> {
    const item = await loadItemForEdit(kind, editingId || undefined);
    slot.innerHTML = '';
    slot.append(buildEditorForm(agentId, kind, item));
  }

  function buildEditorForm(agentId: string, kind: ResourceKind, item: ResourceItem | null): HTMLElement {
    const meta = SUB_TAB_LABELS[kind];
    const isNew = !item;

    const nameInput = h('input', {
      value: item?.name || '',
      placeholder: meta.singular[0].toUpperCase() + meta.singular.slice(1) + ' name',
      maxlength: String(NAME_MAX),
    }) as HTMLInputElement;
    const kindFields = kind === 'memory' ? buildMemoryFields(item) : null;
    const { placeholder, value } = bodyConfigFor(kind, item);
    const bodyInput = h('textarea', { placeholder }) as HTMLTextAreaElement;
    bodyInput.value = value;
    bodyInput.rows = kind === 'skills' ? 10 : kind === 'memory' ? 6 : 8;
    bodyInput.classList.add('resource-body');
    let enabled = item ? item.status !== 'off' : true;
    const enabledSeg = toggleSeg(enabled, on => { enabled = on; }, { labels: ['Inactive', 'Active'] });
    const errLine = h('div', { class: 'agent-err', style: 'display:none' });

    const doSave = async (): Promise<void> => {
      if (!nameInput.value.trim()) { nameInput.focus(); return; }
      const base: ResourceSavePayload = {
        kind,
        id: item?.id || null,
        name: nameInput.value.trim(),
        agentIds: [agentId],
        enabled,
      };
      const payload: ResourceSavePayload = { ...base, ...kindPayloadExtras(kind, bodyInput.value, kindFields) };
      saveBtn.setAttribute('disabled', '');
      saveBtn.textContent = 'Saving…';
      try {
        await api.saveResource(payload);
        await reload();
        showList();
      } catch (e: unknown) {
        saveBtn.removeAttribute('disabled');
        saveBtn.textContent = 'Save';
        errLine.style.display = '';
        errLine.textContent = e instanceof Error ? e.message : String(e);
      }
    };

    const doDelete = async (): Promise<void> => {
      if (!item) return;
      if (!confirmDeleteMode) {
        confirmDeleteMode = true;
        deleteBtn.textContent = 'Confirm delete';
        deleteBtn.classList.add('danger-strong');
        return;
      }
      deleteBtn.setAttribute('disabled', '');
      deleteBtn.textContent = 'Deleting…';
      try {
        await api.deleteResource(kind, item.id);
        await reload();
        showList();
      } catch (e: unknown) {
        deleteBtn.removeAttribute('disabled');
        deleteBtn.textContent = 'Confirm delete';
        errLine.style.display = '';
        errLine.textContent = e instanceof Error ? e.message : String(e);
      }
    };

    const saveBtn = h('button', { class: 'btn primary', onclick: () => void doSave() }, 'Save') as HTMLButtonElement;
    const cancelBtn = h('button', { class: 'btn ghost', onclick: () => showList() }, 'Cancel');
    const deleteBtn: HTMLButtonElement = h('button', { class: 'btn danger', onclick: () => void doDelete() }, 'Delete') as HTMLButtonElement;
    const backBtn = h('button', { class: 'editor-back', type: 'button', onclick: () => showList() },
      h('span', { class: 'editor-back-arrow' }, '←'),
      h('span', {}, isNew ? 'New ' + meta.singular : 'Edit ' + meta.singular));

    return h('div', { class: 'resource-editor' },
      h('div', { class: 'resource-editor-h' }, backBtn),
      h('div', { class: 'resource-editor-body' },
        h('div', { class: 'resource-editor-fields' },
          field('Name', nameInput),
          kindFields ? field('Scope', kindFields.scopeSel) : null,
          kindFields?.wsSelWrap ?? null,
          field(SUB_TAB_LABELS[kind].fieldLabel, bodyInput),
          field('Active', enabledSeg),
          errLine)),
      h('div', { class: 'resource-editor-f' },
        h('div', { class: 'resource-editor-f-left' }, item ? deleteBtn : null),
        h('div', { class: 'resource-editor-f-right' },
          cancelBtn,
          saveBtn)));
  }

  /* ---- data load + actions shared by both views ---- */
  async function reload(): Promise<void> {
    try {
      const raw = await api.listResources(kind);
      allItems = raw.filter(i => i.agentIds.includes(agentId));
    } catch (e) {
      console.error('list resources failed', e);
      allItems = [];
    }
  }

  async function toggleItem(id: string, on: boolean): Promise<void> {
    try { await api.toggleResource(kind, id, on); }
    catch (e) { console.error('toggle resource failed', e); }
    await reload();
    if (mode === 'list') paintList();
  }

  function setMode(m: 'cards' | 'list'): void {
    if (currentView === m) return;
    currentView = m;
    syncSeg(seg, m);
    paintList();
  }

  searchInput.addEventListener('input', paintList);

  /* initial render: list view, then async-load items */
  showList();
  void (async () => {
    await reload();
    if (mode === 'list') paintList();
  })();

  return wrap;
}

function buildSearchInput(meta: { title: string }): HTMLInputElement {
  return h('input', {
    class: 'search-page-input', type: 'search',
    placeholder: 'Search ' + meta.title.toLowerCase() + '…',
  }) as HTMLInputElement;
}

function syncSeg(seg: HTMLElement, viewMode: 'list' | 'cards'): void {
  const [listBtn, cardBtn] = seg.children as HTMLCollectionOf<HTMLElement>;
  listBtn.classList.toggle('on', viewMode === 'list');
  cardBtn.classList.toggle('on', viewMode === 'cards');
}

function buildSubTabBar(agentId: string, current: SubTab, enabled: Record<SubTab, boolean>): HTMLElement {
  const bar = h('div', { class: 'agent-subtab-bar' });
  const order: SubTab[] = ['model', 'memory', 'skills', 'mcp'];
  for (const t of order) {
    const isOn = t === current;
    const isSupported = enabled[t];
    bar.append(h('button', {
      class: 'agent-subtab' + (isOn ? ' active' : '') + (isSupported ? '' : ' off'),
      type: 'button',
      disabled: !isSupported,
      title: !isSupported ? SUB_TAB_LABELS[t].title + ' not supported by this agent' : '',
      onclick: () => go({ view: 'agentDetail', agentId, tab: t }),
    },
      ic(SUB_TAB_LABELS[t].icon),
      h('span', {}, SUB_TAB_LABELS[t].title)));
  }
  return bar;
}

export function agentDetailPage(agentId: string, initialTab: SubTab): HTMLElement {
  const wrap = h('div', { class: 'page agent-detail' });
  const head = h('div', { class: 'agent-detail-h' });
  const body = h('div', { class: 'agent-detail-body' },
    h('div', { class: 'empty-note' }, 'Loading…'));
  wrap.append(head, body);

  let view: AgentConfigView | null = null;
  let currentTab: SubTab = initialTab;

  function paintTab(nextView: AgentConfigView | null, tab: SubTab): void {
    if (!nextView) return;
    const enabled: Record<SubTab, boolean> = {
      model: true,
      memory: nextView.capabilities.memory,
      skills: nextView.capabilities.skills,
      mcp: nextView.capabilities.mcp,
    };
    body.innerHTML = '';
    body.append(buildSubTabBar(agentId, tab, enabled));
    const tabBody = tab === 'model'
      ? buildModelTab(agentId, nextView, (v) => paintTab(v, tab))
      : buildResourceTab(agentId, tab, 'cards');
    body.append(tabBody);
  }

  function paintHead(nextView: AgentConfigView): void {
    head.innerHTML = '';
    const agent = db.agents?.find(a => a.id === agentId) || null;
    head.append(
      h('div', { class: 'agent-detail-id' },
        markup('span', { class: 'agent-card-avatar' }, IC.bot),
        h('div', { class: 'grow' },
          h('b', {}, nextView.name),
          h('span', { class: 'agent-card-detect ' + (nextView.detected ? 'on' : 'off') },
            nextView.detected ? 'Detected' : 'Not detected')),
        h('span', { class: 'muted' },
          nextView.configPath ? h('code', {}, nextView.configPath) : 'No config path')),
      chipEl(agent, { lg: true }),
    );
  }

  void (async () => {
    try {
      const v = await api.agentConfig(agentId);
      if (!v) throw new Error('Agent not found: ' + agentId);
      view = v;
      paintHead(v);
      paintTab(v, currentTab);
    } catch (e: unknown) {
      body.innerHTML = '';
      body.append(h('div', { class: 'empty-note' }, e instanceof Error ? e.message : String(e)));
    }
  })();

  return wrap;
}
