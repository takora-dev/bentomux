/* ---------------- plugin host: loader ----------------
   Spec: docs/PLUGIN_PLATFORM.md §2, §8. Decision: docs/adr/0001.

   Loads a plugin's ES module over `plugin://` and calls `activate(ctx)`.

   Two things this module is careful about:

   * **Lazy where it can be.** A plugin whose manifest declares only UI
     contributions is imported on first use — the topbar button renders from
     the manifest alone, so nothing runs until the user clicks. A plugin that
     declares a service is activated at boot, because a background service has
     no click to wait for.

   * **Never fatal.** Activation runs inside try/catch and a failure marks the
     plugin errored rather than taking down the shell. The realm is shared, so
     a plugin's uncaught error genuinely can break the app — which is why the
     boot path also has safe mode (plugin/boot.rs) as the way back out. */

import api from '../../preload/bentomux';
import {
  beginRegistration,
  createContext,
  dropPlugin,
  serviceEntries,
  unusedDeclarations,
  type ContextDeps,
} from './registry';
import { buildAppFacade } from './facade';
import type { PluginContext, PluginManifest, PluginModule, PluginRecord, Cleanup } from './types';

/* ---------------- platform URL forms ----------------
   Tauri exposes a custom scheme to the webview differently per platform:
     macOS, Linux : plugin://localhost/<id>/<path>
     Windows      : http://plugin.localhost/<id>/<path>
   Both forms are in the CSP. Picking the wrong one yields an opaque import
   failure, so the choice is made once, here, and named. */
const PLUGIN_URL_BASE = /Win/.test(navigator.platform)
  ? 'http://plugin.localhost'
  : 'plugin://localhost';

export function pluginAssetUrl(pluginId: string, path: string): string {
  const clean = path.replace(/^\/+/, '');
  return `${PLUGIN_URL_BASE}/${pluginId}/${clean}`;
}

/* ---------------- status ---------------- */

export type PluginStatus = 'inactive' | 'activating' | 'active' | 'errored' | 'disabled';

interface LoadedPlugin {
  record: PluginRecord;
  manifest: PluginManifest;
  status: PluginStatus;
  error?: string;
  module?: PluginModule;
  /** Bumped on reload so the module URL changes and a fresh instance loads. */
  generation: number;
  /** Resolves once activation settles; callers can await the first load. */
  activation?: Promise<void>;
}

const loaded = new Map<string, LoadedPlugin>();
const listeners = new Set<() => void>();

export function onPluginsChanged(cb: () => void): Cleanup {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function notify(): void {
  for (const cb of listeners) {
    try {
      cb();
    } catch (e) {
      console.error('[plugin-host] change listener threw', e);
    }
  }
}

export function pluginStatuses(): Array<{
  id: string;
  name: string;
  version: string;
  status: PluginStatus;
  error?: string;
  enabled: boolean;
  previousVersion?: string;
  source: PluginRecord['source'];
}> {
  return [...loaded.values()].map(p => ({
    id: p.record.id,
    name: p.manifest.name,
    version: p.record.version,
    status: p.status,
    error: p.error,
    enabled: p.record.enabled,
    previousVersion: p.record.previousVersion,
    source: p.record.source,
  }));
}

export function statusOf(pluginId: string): PluginStatus {
  return loaded.get(pluginId)?.status ?? 'inactive';
}

/** Display name for a plugin, falling back to its id before it has loaded. */
export function pluginDisplayName(pluginId: string): string {
  return loaded.get(pluginId)?.manifest.name || pluginId;
}

/* ---------------- dependency wiring ---------------- */

/**
 * The host half of `ctx`. Kept as a settable object so the plugin host can be
 * built before `main.ts` finishes wiring the app (storage and events both need
 * modules that import this one).
 */
export interface HostBindings {
  storageGet: ContextDeps['storageGet'];
  storageSet: ContextDeps['storageSet'];
  storageDelete: ContextDeps['storageDelete'];
  storageKeys: ContextDeps['storageKeys'];
  hostEvent: ContextDeps['hostEvent'];
  /** Open a declared tab in the app's tab strip. */
  openTab: ContextDeps['openTab'];
  /** Open a declared modal in the app's modal root. */
  openModal: ContextDeps['openModal'];
}

let bindings: HostBindings | null = null;

export function bindHost(b: HostBindings): void {
  bindings = b;
}

/* ---------------- activation ---------------- */

function manifestNeedsEagerActivation(manifest: PluginManifest): boolean {
  return (manifest.contributes?.services?.length ?? 0) > 0;
}

/** Fetch a manifest for an installed plugin from the backend. */
async function fetchManifest(pluginId: string): Promise<PluginManifest> {
  return api.pluginManifest(pluginId) as Promise<PluginManifest>;
}

export interface LoadOptions {
  /** Force activation now instead of waiting for first use. */
  eager?: boolean;
}

/**
 * Make a plugin ready. Idempotent: a plugin already active is left alone.
 *
 * Returns once the plugin is active, errored, or skipped. It never throws —
 * a plugin that cannot load is a state the UI reports, not an exception the
 * caller has to handle.
 */
export async function loadPlugin(record: PluginRecord, opts: LoadOptions = {}): Promise<void> {
  const existing = loaded.get(record.id);

  if (!record.enabled) {
    if (existing) {
      deactivatePlugin(record.id);
      existing.record = record;
      existing.status = 'disabled';
      notify();
      return;
    }
    /* a disabled plugin still belongs in the list: a row that vanishes at
       reboot would leave no way to turn it back on */
    const disabled: LoadedPlugin = {
      record,
      manifest: { id: record.id, name: record.id, version: record.version, apiVersion: 1, entry: '' },
      status: 'disabled',
      generation: 0,
    };
    loaded.set(record.id, disabled);
    try {
      disabled.manifest = await fetchManifest(record.id);
    } catch (e) {
      console.warn(`[plugin-host] could not read the manifest of disabled plugin ${record.id}`, e);
    }
    notify();
    return;
  }

  if (existing?.status === 'active' || existing?.status === 'activating') {
    existing.record = record;
    return;
  }

  /* manifest first: it decides whether this can stay lazy */
  let manifest: PluginManifest;
  try {
    manifest = await fetchManifest(record.id);
  } catch (e) {
    loaded.set(record.id, {
      record,
      manifest: { id: record.id, name: record.id, version: record.version, apiVersion: 1, entry: '' },
      status: 'errored',
      error: `could not read the manifest: ${String(e)}`,
      generation: 0,
    });
    notify();
    return;
  }

  const slot: LoadedPlugin = existing ?? {
    record,
    manifest,
    status: 'inactive',
    generation: 0,
  };
  slot.record = record;
  slot.manifest = manifest;
  loaded.set(record.id, slot);

  if (!opts.eager && !manifestNeedsEagerActivation(manifest)) {
    /* leave it inactive; `ensureActive` runs activation on first use */
    if (slot.status !== 'errored') slot.status = 'inactive';
    notify();
    return;
  }

  await activate(record.id);
}

/**
 * Activate a plugin that was loaded lazily. Safe to call from a click handler:
 * the returned promise resolves when the plugin is active or has failed.
 */
export async function ensureActive(pluginId: string): Promise<boolean> {
  const slot = loaded.get(pluginId);
  if (!slot) return false;
  if (slot.status === 'active') return true;
  if (slot.status === 'errored' || slot.status === 'disabled') return false;
  if (slot.activation) return slot.activation.then(() => slot.status === 'active');
  return activate(pluginId);
}

async function activate(pluginId: string): Promise<boolean> {
  const slot = loaded.get(pluginId);
  if (!slot) return false;
  if (!bindings) {
    slot.status = 'errored';
    slot.error = 'the plugin host is not wired yet';
    notify();
    return false;
  }
  /* A manifest that could not be read leaves an empty entry. Importing
     `plugin://<id>/?…` would fail with an opaque "failed to fetch dynamically
     imported module" — say what is actually wrong instead. */
  if (!slot.manifest.entry) {
    slot.status = 'errored';
    slot.error = 'the plugin manifest could not be read, so its entry point is unknown';
    notify();
    return false;
  }

  slot.status = 'activating';
  notify();

  const run = (async () => {
    beginRegistration(slot.manifest);
    const deps: ContextDeps = {
      storageGet: bindings.storageGet,
      storageSet: bindings.storageSet,
      storageDelete: bindings.storageDelete,
      storageKeys: bindings.storageKeys,
      appFacade: (id, permissions) => buildAppFacade(id, permissions),
      hostEvent: bindings.hostEvent,
      openTab: bindings.openTab,
      openModal: bindings.openModal,
    };
    const ctx: PluginContext = createContext(slot.manifest, deps);

    /* cache-bust by generation and content hash: a reload must produce a new
       module instance, and an update must not run the previous version */
    const generation = ++slot.generation;
    const url = `${pluginAssetUrl(slot.manifest.id, slot.manifest.entry)}?h=${slot.record.sha256.slice(0, 8)}&g=${generation}`;

    const mod = (await import(/* @vite-ignore */ url)) as PluginModule;
    if (typeof mod.activate !== 'function') {
      throw new Error(`entry does not export an \`activate(ctx)\` function`);
    }
    slot.module = mod;
    await mod.activate(ctx);

    /* declared-but-never-registered is a manifest/code mismatch, not a
       failure: report it and keep the plugin running */
    const unused = unusedDeclarations(slot.manifest.id);
    if (unused.length) {
      console.warn(
        `[plugin:${slot.manifest.id}] declared but never registered: ${unused.join(', ')}`,
      );
    }
  })();

  slot.activation = run.then(
    () => {
      slot.status = 'active';
      slot.error = undefined;
      notify();
    },
    err => {
      /* a failed activation must not leave half its contributions behind */
      dropPlugin(pluginId);
      slot.status = 'errored';
      slot.error = err instanceof Error ? err.message : String(err);
      console.error(`[plugin:${pluginId}] activation failed`, err);
      notify();
    },
  );

  await slot.activation;
  /* read back through the map: the status was assigned inside the promise
     callbacks above, which the compiler cannot see through */
  return loaded.get(pluginId)?.status === 'active';
}

/**
 * Tear a plugin down without unloading its code (which is impossible).
 *
 * `dropPlugin` releases the registry's half — commands, renderers, disposers.
 * The host's half is released by the `hostTeardown` hook, which unmounts any
 * UI the plugin rendered into the shell; without it a disabled plugin's tab
 * body would keep running its listeners.
 */
export function deactivatePlugin(pluginId: string): void {
  const slot = loaded.get(pluginId);
  if (!slot) return;
  try {
    void slot.module?.deactivate?.();
  } catch (e) {
    console.error(`[plugin:${pluginId}] deactivate() threw`, e);
  }
  dropPlugin(pluginId);
  try {
    hostTeardown?.(pluginId);
  } catch (e) {
    console.error(`[plugin:${pluginId}] host teardown threw`, e);
  }
  slot.module = undefined;
  if (slot.status === 'active') slot.status = 'inactive';
}

/* The host's half of teardown: unmounting plugin UI that lives inside the
   shell. Injected rather than imported so the loader does not depend on the
   renderer's module graph. */let hostTeardown: ((pluginId: string) => void) | null = null;

export function onTeardown(fn: (pluginId: string) => void): void {
  hostTeardown = fn;
}

/**
 * Reload: tear down, re-read the manifest, then activate a fresh module
 * instance.
 *
 * Re-reading the manifest is the point. A reload is how a user recovers from
 * a broken install or picks up an update, and both change the manifest — so
 * reloading straight into `activate()` would run against the stale copy that
 * was read when the plugin first loaded. That is how a plugin whose files were
 * repaired stayed broken until the app restarted.
 */
export async function reloadPlugin(pluginId: string): Promise<boolean> {
  deactivatePlugin(pluginId);

  const slot = loaded.get(pluginId);
  if (!slot) return false;

  try {
    slot.manifest = await fetchManifest(pluginId);
  } catch (e) {
    slot.status = 'errored';
    slot.error = `could not read the manifest: ${String(e)}`;
    notify();
    return false;
  }

  return activate(pluginId);
}

/**
 * Drop a plugin the host must forget: its services, its registry half, its
 * loaded slot.
 *
 * Uninstall calls this. `deactivatePlugin` alone is not enough — it leaves the
 * slot in `loaded`, so the manifest that drives every surface stays reachable
 * and the uninstalled plugin's buttons, rows and commands keep rendering until
 * the next launch. That is what a user sees as "uninstall did nothing".
 */
export function forgetPlugin(pluginId: string): void {
  abortServices(pluginId);
  deactivatePlugin(pluginId);
  loaded.delete(pluginId);
  notify();
}

/**
 * Flip `enabled` in the backend and make the host match it.
 *
 * The studio row reads its state off the loaded record, so a backend write
 * alone leaves the button where it was — and disabling must also tear the
 * plugin down, or "Disable" lets it keep running.
 */
export async function setPluginEnabled(pluginId: string, enabled: boolean): Promise<void> {
  await api.pluginSetEnabled(pluginId, enabled);
  const slot = loaded.get(pluginId);
  if (!slot) return;
  slot.record = { ...slot.record, enabled };
  if (!enabled) {
    abortServices(pluginId);
    deactivatePlugin(pluginId);
    slot.status = 'disabled';
    notify();
    return;
  }
  await reloadPlugin(pluginId);
  /* services only start at boot otherwise, so an enabled-again plugin would
     run without them until the next launch */
  startServices();
}

/* ---------------- boot ---------------- */

/**
 * Bring the registry up to date with the backend and activate what must be
 * eager. Called once after the shell has painted, so service startup never
 * delays first paint.
 */
export async function initPlugins(): Promise<void> {
  let records: PluginRecord[];
  let safeMode = false;
  try {
    const [list, status] = await Promise.all([
      api.pluginList() as Promise<PluginRecord[]>,
      api.pluginSafeMode() as Promise<{ safeMode: boolean }>,
    ]);
    records = list;
    safeMode = status.safeMode;
  } catch (e) {
    console.error('[plugin-host] could not read the plugin registry', e);
    return;
  }

  for (const record of records) {
    if (safeMode && !isBundled(record)) {
      /* safe mode disables third-party plugins; bundled ones are part of the
         app and ship with it */
      loaded.set(record.id, {
        record: { ...record, enabled: false },
        manifest: { id: record.id, name: record.id, version: record.version, apiVersion: 1, entry: '' },
        status: 'disabled',
        generation: 0,
      });
      continue;
    }
    await loadPlugin(record);
  }

  /* services start now: the window is interactive and painted */
  startServices();
  notify();
}

function isBundled(record: PluginRecord): boolean {
  return record.source?.kind === 'bundled';
}

/* ---------------- services ---------------- */

const serviceAborts = new Map<string, AbortController>();

function abortServices(pluginId: string): void {
  for (const [key, controller] of serviceAborts) {
    if (!key.startsWith(`${pluginId}:`)) continue;
    controller.abort();
    serviceAborts.delete(key);
  }
}

function startServices(): void {
  for (const entry of serviceEntries()) {
    const key = `${entry.pluginId}:${entry.contribution.id}`;
    if (serviceAborts.has(key)) continue;
    const controller = new AbortController();
    serviceAborts.set(key, controller);
    /* a service that throws marks its plugin errored — it does not take the
       app down, and the user can see which plugin failed */
    try {
      void Promise.resolve(entry.run(controller.signal)).catch(err => {
        console.error(`[plugin:${entry.pluginId}] service \`${entry.contribution.id}\` failed`, err);
        const slot = loaded.get(entry.pluginId);
        /* a disabled plugin's services are aborted on purpose — that
           rejection must not mark it errored */
        if (slot && slot.status !== 'disabled') {
          slot.status = 'errored';
          slot.error = `service failed: ${err instanceof Error ? err.message : String(err)}`;
          notify();
        }
      });
    } catch (err) {
      console.error(`[plugin:${entry.pluginId}] service \`${entry.contribution.id}\` threw`, err);
    }
  }
}

export function stopServices(): void {
  for (const controller of serviceAborts.values()) controller.abort();
  serviceAborts.clear();
}
