/* ---------------- plugin host: contribution registry ----------------
   Spec: docs/PLUGIN_PLATFORM.md §6–§7.

   The single place that knows what plugins have contributed. Host surfaces
   (topbar, sidebar, dock, tab strip, welcome page, command palette, settings)
   ask this module for entries and render whatever comes back — with no
   plugins installed every accessor returns empty, so the existing UI renders
   exactly as it did before the platform existed.

   Contributions are keyed by the ids the manifest declared. Registering an id
   the manifest never declared is refused, and declaring an id nothing ever
   registers is reported as a warning at the end of activation — that pairing
   is what keeps a manifest honest about what it adds. */

import type {
  Contribution,
  ContributionKind,
  PluginContext,
  PluginManifest,
  PluginPermission,
  RenderFn,
  Cleanup,
} from './types';

/* ---------------- entry shapes ---------------- */

/** A declared entry that fires a command (topbar / sidebar / dock). */
export interface CommandEntry {
  pluginId: string;
  pluginName: string;
  contribution: Contribution;
  run: (args?: unknown) => void;
}

/** A declared entry with a body renderer (tab / modal / widget / settings). */
export interface BodyEntry {
  pluginId: string;
  pluginName: string;
  contribution: Contribution;
  render: RenderFn;
}

export interface ServiceEntry {
  pluginId: string;
  pluginName: string;
  contribution: Contribution;
  run: (signal: AbortSignal) => void | Promise<void>;
}

/* ---------------- registry state ---------------- */

interface PluginSlot {
  id: string;
  name: string;
  manifest: PluginManifest;
  /** Declared ids per kind, so registration can be checked against them. */
  declared: Map<ContributionKind, Set<string>>;
  /** Ids that were declared *and* registered — the rest are warned about. */
  used: Set<string>;
  disposers: Cleanup[];
  commands: Map<string, (args?: unknown) => void>;
  tabs: Map<string, RenderFn>;
  modals: Map<string, RenderFn>;
  widgets: Map<string, RenderFn>;
  settings: Map<string, (paint: () => void) => HTMLElement>;
  services: Map<string, (signal: AbortSignal) => void | Promise<void>>;
  errors: string[];
}

const slots = new Map<string, PluginSlot>();

/* ---------------- registration lifecycle ---------------- */

/**
 * Open a registration slot for a plugin.
 *
 * `slotKey` defaults to the plugin id. A distinct key is allowed so a caller
 * can register a plugin's contributions without touching the slot of the same
 * plugin when it is genuinely installed and running.
 */
export function beginRegistration(manifest: PluginManifest, slotKey: string = manifest.id): void {
  const declared = new Map<ContributionKind, Set<string>>();
  const contributes = manifest.contributes ?? {};
  for (const [kind, list] of Object.entries(contributes) as [ContributionKind, Contribution[]][]) {
    declared.set(kind, new Set((list ?? []).map(c => c.id)));
  }
  slots.set(slotKey, {
    id: manifest.id,
    name: manifest.name,
    manifest,
    declared,
    used: new Set(),
    disposers: [],
    commands: new Map(),
    tabs: new Map(),
    modals: new Map(),
    widgets: new Map(),
    settings: new Map(),
    services: new Map(),
    errors: [],
  });
}

/** True when the manifest declared this id under this kind. */
function isDeclared(slot: PluginSlot, kind: ContributionKind, id: string): boolean {
  return slot.declared.get(kind)?.has(id) ?? false;
}

function slotFor(pluginId: string): PluginSlot | undefined {
  return slots.get(pluginId);
}

/** The manifest entry a plugin declared for one id, if any. */
function findContribution(
  pluginId: string,
  kind: ContributionKind,
  id: string,
): Contribution | undefined {
  const list = (slotFor(pluginId)?.manifest.contributes?.[kind] ?? []) as Contribution[];
  return list.find(c => c.id === id);
}

export class RegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistrationError';
  }
}

function requireDeclared(
  slotKey: string,
  kind: ContributionKind,
  id: string,
  pluginId: string = slotKey,
): PluginSlot {
  const slot = slotFor(slotKey);
  if (!slot) throw new RegistrationError(`plugin ${pluginId} is not activating`);
  if (!isDeclared(slot, kind, id)) {
    throw new RegistrationError(
      `${pluginId}: contributes.${kind} does not declare \`${id}\` — declare it in plugin.json before registering it`,
    );
  }
  slot.used.add(id);
  return slot;
}

/* ---------------- the ctx handed to a plugin ---------------- */

export interface ContextDeps {
  /** Read one key from the plugin's own data store. */
  storageGet: (pluginId: string, key: string) => Promise<unknown>;
  storageSet: (pluginId: string, key: string, value: unknown) => Promise<void>;
  storageDelete: (pluginId: string, key: string) => Promise<void>;
  storageKeys: (pluginId: string) => Promise<string[]>;
  /** The permission-scoped view of the app bridge. */
  appFacade: (pluginId: string, permissions: PluginPermission[]) => Record<string, (...args: never[]) => unknown>;
  /** Subscribe to a host lifecycle event. */
  hostEvent: (event: string, cb: (payload: unknown) => void) => Cleanup;
  /** Open a tab the plugin declared, in the app's tab strip. */
  openTab: (pluginId: string, tabId: string, title: string) => boolean;
  /** Open a modal the plugin declared, in the app's modal root. */
  openModal: (pluginId: string, modalId: string, title: string) => boolean;
}

export function createContext(
  manifest: PluginManifest,
  deps: ContextDeps,
  slotKey: string = manifest.id,
): PluginContext {
  const pluginId = manifest.id;
  const permissions = manifest.permissions ?? [];

  const ctx: PluginContext = {
    plugin: { id: pluginId, version: manifest.version },

    log: (...args: unknown[]) => {
      /* console, not a log file: plugin output belongs next to the app's own
         messages so a user debugging a plugin sees it in the same place */
      console.log(`[plugin:${pluginId}]`, ...args);
    },

    storage: {
      get: <T = unknown>(key: string) => deps.storageGet(pluginId, key) as Promise<T | undefined>,
      set: (key: string, value: unknown) => deps.storageSet(pluginId, key, value),
      delete: (key: string) => deps.storageDelete(pluginId, key),
      keys: () => deps.storageKeys(pluginId),
    },

    app: deps.appFacade(pluginId, permissions),

    events: {
      /* the overloads on PluginEvents give each callback its own payload type;
         the host hands every one of them `unknown` and rethrows the narrowing
         at the boundary, so cast back to the declared listener shape here */
      on: (event, cb) => deps.hostEvent(event, cb as (payload: unknown) => void),
    },

    ui: {
      command: (id, handler) => {
        const slot = requireDeclared(slotKey, 'commands', id, pluginId);
        slot.commands.set(id, handler);
      },
      tab: (id, render) => {
        requireDeclared(slotKey, 'tabs', id, pluginId).tabs.set(id, render);
      },
      modal: (id, render) => {
        requireDeclared(slotKey, 'modals', id, pluginId).modals.set(id, render);
      },
      widget: (id, render) => {
        requireDeclared(slotKey, 'widgets', id, pluginId).widgets.set(id, render);
      },
      settingsSection: (id, build) => {
        requireDeclared(slotKey, 'settings', id, pluginId).settings.set(id, build);
      },
      service: (id, run) => {
        requireDeclared(slotKey, 'services', id, pluginId).services.set(id, run);
      },
      openTab: (id) => {
        /* opening is separate from registering: declaring a tab is not the
           same as showing it, and the plugin decides when to call this */
        requireDeclared(slotKey, 'tabs', id, pluginId);
        const contribution = findContribution(slotKey, 'tabs', id);
        const title = contribution?.title ?? id;
        if (!deps.openTab(pluginId, id, title)) {
          throw new RegistrationError(
            `${pluginId}: no renderer registered for tab \`${id}\` — call ctx.ui.tab(\`${id}\`, render) first`,
          );
        }
      },
      openModal: (id) => {
        requireDeclared(slotKey, 'modals', id, pluginId);
        const contribution = findContribution(slotKey, 'modals', id);
        const title = contribution?.title ?? id;
        if (!deps.openModal(pluginId, id, title)) {
          throw new RegistrationError(
            `${pluginId}: no renderer registered for modal \`${id}\` — call ctx.ui.modal(\`${id}\`, render) first`,
          );
        }
      },
    },

    dispose: (fn) => {
      const slot = slotFor(slotKey);
      if (slot) slot.disposers.push(fn);
    },
  };

  return ctx;
}

/* ---------------- teardown ---------------- */

/**
 * Drop everything a plugin registered and run its disposers.
 *
 * ES modules cannot be unloaded, so a reload re-imports under a cache-busting
 * URL and leaks the old module scope. Honest teardown is what keeps that leak
 * to memory rather than behaviour: every listener and every node this plugin
 * owns is released here, even though its closures stay alive.
 */
export function dropPlugin(pluginId: string): void {
  const slot = slots.get(pluginId);
  if (!slot) return;
  for (const dispose of slot.disposers.splice(0)) {
    try {
      dispose();
    } catch (e) {
      console.error(`[plugin:${pluginId}] dispose failed`, e);
    }
  }
  slots.delete(pluginId);
}

/** Ids a plugin declared but never registered — a manifest/code mismatch. */
export function unusedDeclarations(pluginId: string): string[] {
  const slot = slots.get(pluginId);
  if (!slot) return [];
  const unused: string[] = [];
  for (const ids of slot.declared.values()) {
    for (const id of ids) {
      if (!slot.used.has(id)) unused.push(id);
    }
  }
  return unused;
}

/* ---------------- accessors the host surfaces call ----------------
   Every one returns an empty array when nothing is registered, so a surface
   that renders "whatever the registry has" is unchanged with no plugins. */

function allSlots(): PluginSlot[] {
  return [...slots.values()];
}

/** A declared entry as it appears in a list, with its command resolved. */
function asCommandEntry(slot: PluginSlot, kind: ContributionKind): CommandEntry[] {
  const list = (slot.manifest.contributes?.[kind] ?? []) as Contribution[];
  const out: CommandEntry[] = [];
  for (const contribution of list) {
    const commandId = contribution.command;
    if (!commandId) continue;
    out.push({
      pluginId: slot.id,
      pluginName: slot.name,
      contribution,
      run: (args?: unknown) => {
        const handler = slotFor(slot.id)?.commands.get(commandId);
        if (!handler) {
          console.warn(`[plugin:${slot.id}] command \`${commandId}\` has no handler registered`);
          return;
        }
        try {
          void handler(args);
        } catch (e) {
          console.error(`[plugin:${slot.id}] command \`${commandId}\` threw`, e);
        }
      },
    });
  }
  return out;
}

export function topbarEntries(): CommandEntry[] {
  return allSlots().flatMap(s => asCommandEntry(s, 'topbar'));
}

export function sidebarEntries(): CommandEntry[] {
  return allSlots().flatMap(s => asCommandEntry(s, 'sidebar'));
}

export function dockEntries(): CommandEntry[] {
  return allSlots().flatMap(s => asCommandEntry(s, 'dock'));
}

/** Every declared command, for the palette. */
export function commandEntries(): Array<{
  pluginId: string;
  pluginName: string;
  contribution: Contribution;
  run: (args?: unknown) => void;
}> {
  return allSlots().flatMap(s => asCommandEntry(s, 'commands'));
}

function bodyEntries(kind: ContributionKind): BodyEntry[] {
  const out: BodyEntry[] = [];
  for (const slot of allSlots()) {
    const list = (slot.manifest.contributes?.[kind] ?? []) as Contribution[];
    for (const contribution of list) {
      const render = bodyRendererFor(slot, kind, contribution.id);
      if (render) {
        out.push({ pluginId: slot.id, pluginName: slot.name, contribution, render });
      }
    }
  }
  return out;
}

function bodyRendererFor(slot: PluginSlot, kind: ContributionKind, id: string): RenderFn | undefined {
  switch (kind) {
    case 'tabs': return slot.tabs.get(id);
    case 'modals': return slot.modals.get(id);
    case 'widgets': return slot.widgets.get(id);
    default: return undefined;
  }
}

export function widgetEntries(): BodyEntry[] {
  return bodyEntries('widgets');
}

/** Declared tabs across every plugin, for the tab strip. */
export function declaredTabs(): Array<{ pluginId: string; pluginName: string; contribution: Contribution }> {
  return bodyEntries('tabs').map(({ pluginId, pluginName, contribution }) => ({
    pluginId, pluginName, contribution,
  }));
}

export function tabRenderer(pluginId: string, tabId: string): RenderFn | undefined {
  return slotFor(pluginId)?.tabs.get(tabId);
}

export function widgetRenderer(pluginId: string, widgetId: string): RenderFn | undefined {
  return slotFor(pluginId)?.widgets.get(widgetId);
}

export function modalRenderer(pluginId: string, modalId: string): RenderFn | undefined {
  return slotFor(pluginId)?.modals.get(modalId);
}

/** Open a plugin modal by id, if a handler is registered. */
export function openPluginModal(pluginId: string, modalId: string): boolean {
  const render = modalRenderer(pluginId, modalId);
  if (!render) return false;
  return true;
}

export function settingsSectionEntries(): Array<{
  pluginId: string;
  contribution: Contribution;
  build: (paint: () => void) => HTMLElement;
}> {
  const out: Array<{ pluginId: string; contribution: Contribution; build: (paint: () => void) => HTMLElement }> = [];
  for (const slot of allSlots()) {
    const list = (slot.manifest.contributes?.settings ?? []) as Contribution[];
    for (const contribution of list) {
      const build = slot.settings.get(contribution.id);
      if (build) out.push({ pluginId: slot.id, contribution, build });
    }
  }
  return out;
}

/** Services a plugin declared and registered — started at boot. */
export function serviceEntries(): ServiceEntry[] {
  const out: ServiceEntry[] = [];
  for (const slot of allSlots()) {
    const list = (slot.manifest.contributes?.services ?? []) as Contribution[];
    for (const contribution of list) {
      const run = slot.services.get(contribution.id);
      if (run) out.push({ pluginId: slot.id, pluginName: slot.name, contribution, run });
    }
  }
  return out;
}

/** True when any plugin contributed something to this surface. */
export function hasAnyContribution(): boolean {
  return allSlots().length > 0;
}

/** Test seam: forget everything without running disposers. */
export function resetRegistry(): void {
  slots.clear();
}
