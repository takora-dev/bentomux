/* ---------------- Plugin Studio ----------------
   Spec: docs/PLUGIN_PLATFORM.md §8, §11.

   The in-app surface for managing plugins. It lives inside the existing
   Settings modal rather than a window of its own, so the platform adds no new
   shell chrome to an app whose UI is meant to stay intact.

   Two behaviours here carry the weight of the trust model (docs/adr/0001):

   * **Validate before install.** The folder is checked statically first and
     the user sees what the plugin will add — contributions and permissions —
     before anything is copied or activated.
   * **State the boundary honestly.** The permission list is a contract, not a
     sandbox, and the review screen says so rather than implying protection
     the platform does not provide. */

import { h } from '../dom';
import api from '../../preload/bentomux';
import { openModal } from '../components/modal';
import {
  pluginStatuses,
  reloadPlugin,
  forgetPlugin,
  setPluginEnabled,
  onPluginsChanged,
  type PluginStatus,
} from '../plugin/loader';
import { describePermissions } from '../plugin/facade';
import { openCreator } from './pluginCreator';
import { restartApp } from '../updates';
import type {
  PluginManifest,
  PluginPermission,
  ValidationReport,
} from '../plugin/types';
import { CONTRIBUTION_KINDS } from '../plugin/types';

/* ---------------- section entry point ---------------- */

export function buildPluginsSection(_paint: () => void): HTMLElement {
  const host = h('div', { class: 'plugin-studio' });

  const render = (): void => {
    host.innerHTML = '';
    host.append(studioHeader(render));

    const plugins = pluginStatuses();
    if (!plugins.length) {
      host.append(
        h('p', { class: 'plugin-empty' },
          'No plugins installed. A plugin can add topbar buttons, sidebar entries, ' +
          'tabs, modals, widgets, commands, and background services.'),
      );
      return;
    }
    for (const plugin of plugins) host.append(pluginRow(plugin, render));
  };

  /* activation is lazy, so a plugin's status moves from "Not started" to
     "Active" only after the user first uses it — the list follows along */
  const off = onPluginsChanged(render);
  render();
  watchRemoval(host, off);

  return host;
}

/** Drop the change subscription when the modal closes. */
function watchRemoval(host: HTMLElement, off: () => void): void {
  queueMicrotask(() => {
    if (!host.isConnected) return;
    const observer = new MutationObserver(() => {
      if (!document.body.contains(host)) {
        off();
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
}

function studioHeader(rerender: () => void): HTMLElement {
  return h('div', { class: 'plugin-studio-head' },
    h('button', {
      class: 'btn primary',
      type: 'button',
      onclick: () => void installFlow(rerender),
    }, 'Install plugin…'),
    h('button', {
      class: 'btn',
      type: 'button',
      title: 'Create a plugin from a template',
      onclick: () => openCreator(),
    }, 'Create…'),
    h('button', {
      class: 'btn',
      type: 'button',
      title: 'Install the bentomux-plugin-author skill into your agent so it can write plugins for you',
      onclick: () => void installSkillFlow(),
    }, 'Install authoring skill…'),
  );
}

/**
 * Copy the authoring skill into an agent's skills directory.
 *
 * This is the half of the platform the app cannot do itself: the app
 * scaffolds, validates, and packages; the intelligence is the user's
 * agent. Handing it the skill is what closes that loop.
 */
async function installSkillFlow(): Promise<void> {
  let targets: Awaited<ReturnType<typeof api.pluginSkillTargets>>;
  try {
    targets = await api.pluginSkillTargets();
  } catch (e) {
    showError('Could not look for agent skills directories', readableError(e));
    return;
  }
  if (!targets.length) {
    showError(
      'No agent found',
      'Bentomux could not find a skills directory it knows how to write to. ' +
      'Install Claude Code, or copy the skill folder from the app resources yourself.',
    );
    return;
  }

  openModal({
    title: 'Install the authoring skill',
    body: h('div', { class: 'plugin-review' },
      h('p', {},
        'This copies the bentomux-plugin-author skill into your agent, so it knows how ' +
        'to write plugins for Bentomux.'),
      ...targets.map(t => h('div', { class: 'plugin-skill-target' },
        h('div', { class: 'plugin-skill-agent' }, t.agentName),
        h('div', { class: 'plugin-row-id' }, t.path),
        h('button', {
          class: 'btn',
          type: 'button',
          onclick: () => {
            void api.pluginInstallSkill(t.agentId)
              .then(dest => showError('Skill installed', `Written to ${dest}`))
              .catch(e => showError('Could not install the skill', readableError(e)));
          },
        }, t.installed ? 'Reinstall' : 'Install'),
      )),
      h('p', { class: 'plugin-review-note' },
        'The skill is a folder with reference documents and examples. It will appear in ' +
        'the Skills screen, but editing it there changes only SKILL.md — the reference ' +
        'files must be edited on disk.'),
    ),
  });
}

/* ---------------- install ---------------- */

async function installFlow(rerender: () => void): Promise<void> {
  const choice = await chooseSource();
  if (!choice) return;

  if (choice === 'folder') {
    const path = await api.pluginChooseFolder();
    if (!path) return;
    await reviewAndInstall(path, 'folder', rerender);
    return;
  }
  if (choice === 'zip') {
    const path = await api.pluginChooseZip();
    if (!path) return;
    await reviewAndInstall(path, 'zip', rerender);
  }
}

/** Ask which kind of source, since the two take different pickers. */
function chooseSource(): Promise<'folder' | 'zip' | null> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (v: 'folder' | 'zip' | null): void => {
      if (settled) return;
      settled = true;
      modal.close();
      resolve(v);
    };

    const modal = openModal({
      title: 'Install a plugin',
      body: h('div', { class: 'plugin-install-choice' },
        h('p', {}, 'Where is the plugin coming from?'),
        h('button', {
          class: 'btn', type: 'button',
          onclick: () => finish('folder'),
        }, 'A folder on this computer'),
        h('button', {
          class: 'btn', type: 'button',
          onclick: () => finish('zip'),
        }, 'A plugin package (.zip)'),
      ),
      onClose: () => finish(null),
    });
  });
}

/**
 * Validate first, show what the plugin will add, then install.
 *
 * The review step is the point of the whole flow: a user should be able to see
 * the contributions and permissions before any code is copied onto disk, let
 * alone activated.
 */
async function reviewAndInstall(
  path: string,
  kind: 'folder' | 'zip',
  rerender: () => void,
): Promise<void> {
  let report: ValidationReport;
  try {
    report = await api.pluginValidate(path, false);
  } catch (e) {
    showError('Could not read that plugin', String(e));
    return;
  }

  if (!report.ok) {
    showValidationReport(report);
    return;
  }

  const manifest = report.manifest;
  if (!manifest) {
    showError('Could not read that plugin', 'The validator returned no manifest.');
    return;
  }

  const confirmed = await confirmInstall(manifest, report);
  if (!confirmed) return;

  const knownBefore = new Set(pluginStatuses().map(p => p.id));
  try {
    const record = kind === 'folder'
      ? await api.pluginInstallFolder(path)
      : await api.pluginInstallZip(path);
    await reloadPlugin(record.id);
    rerender();
    /* a plugin the host already knows reloads in place; a brand-new one only
       joins the loaded set at boot, so the user is told to restart */
    if (!knownBefore.has(record.id)) showRestartNotice(manifest.name);
  } catch (e) {
    showError('Install failed', readableError(e));
  }
}

/* ---------------- restart notice ---------------- */

/**
 * Say that a fresh install needs a restart, and offer it.
 *
 * The loader's set of known plugins is built once, at boot (`initPlugins`), so
 * a plugin installed in this session is not in the list, the topbar, or the
 * palette yet — `reloadPlugin` cannot pick up an id it has never seen. Rather
 * than let the user wonder where their plugin went, the notice explains it and
 * restarts on one click.
 *
 * A restart is cheap here: panes belong to the pty host daemon, so quitting
 * leaves terminals and agents running.
 */
export function showRestartNotice(pluginName: string): void {
  const modal = openModal({
    title: 'Restart to finish installing',
    body: h('div', { class: 'plugin-review' },
      h('p', {},
        pluginName + ' is installed. Bentomux reads its plugin list at startup, ' +
        'so restart the app to see and use the new plugin.'),
      h('p', { class: 'plugin-review-note' },
        'Your terminals and agents keep running — they live in the background ' +
        'session daemon, not in this window.'),
    ),
    footer: h('div', { class: 'plugin-review-foot' },
      h('button', {
        class: 'btn',
        type: 'button',
        onclick: () => modal.close(),
      }, 'Restart later'),
      h('button', {
        class: 'btn primary',
        type: 'button',
        onclick: () => {
          void restartApp().catch(e => showError('Could not restart', readableError(e)));
        },
      }, 'Restart'),
    ),
  });
}

function confirmInstall(manifest: PluginManifest, report: ValidationReport): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (v: boolean): void => {
      if (settled) return;
      settled = true;
      modal.close();
      resolve(v);
    };

    const modal = openModal({
      title: 'Install ' + manifest.name + '?',
      body: h('div', { class: 'plugin-review' },
        h('div', { class: 'plugin-review-id' }, manifest.id + ' · v' + manifest.version),
        manifest.description ? h('p', { class: 'plugin-review-desc' }, manifest.description) : null,
        contributionSummary(manifest),
        permissionSummary(manifest),
        report.warnings.length ? warningList(report.warnings.map(w => w.message)) : null,
      ),
      footer: h('div', { class: 'plugin-review-foot' },
        h('button', { class: 'btn', type: 'button', onclick: () => finish(false) }, 'Cancel'),
        h('button', { class: 'btn primary', type: 'button', onclick: () => finish(true) }, 'Install'),
      ),
      onClose: () => finish(false),
    });
  });
}

function contributionSummary(manifest: PluginManifest): HTMLElement | null {
  const contributes = manifest.contributes ?? {};
  const lines: string[] = [];
  for (const kind of CONTRIBUTION_KINDS) {
    const list = contributes[kind];
    if (!list?.length) continue;
    for (const c of list) lines.push(`${kind.replace(/s$/, '')}: ${c.title ?? c.id}`);
  }
  if (!lines.length) return null;
  return h('div', { class: 'plugin-review-block' },
    h('div', { class: 'plugin-review-label' }, 'This plugin will add'),
    h('ul', { class: 'plugin-review-list' }, ...lines.map(l => h('li', {}, l))),
  );
}

function permissionSummary(manifest: PluginManifest): HTMLElement {
  const permissions = (manifest.permissions ?? []) as PluginPermission[];
  const described = describePermissions(permissions);
  return h('div', { class: 'plugin-review-block' },
    h('div', { class: 'plugin-review-label' }, 'It asks for'),
    described.length
      ? h('ul', { class: 'plugin-review-list' }, ...described.map(d => h('li', {}, d)))
      : h('p', { class: 'plugin-review-none' }, 'No special access.'),
    /* the honest caveat: plugins run in the app's own realm, so this list is
       a statement of intent, not a wall (docs/adr/0001) */
    h('p', { class: 'plugin-review-note' },
      'Plugins run inside Bentomux and are not sandboxed. Install plugins you trust, ' +
      'the same way you would trust an app you download.'),
  );
}

function warningList(messages: string[]): HTMLElement {
  return h('div', { class: 'plugin-review-block' },
    h('div', { class: 'plugin-review-label' }, 'Warnings'),
    h('ul', { class: 'plugin-review-list warnings' }, ...messages.map(m => h('li', {}, m))),
  );
}

/* ---------------- error / report dialogs ---------------- */

function showValidationReport(report: ValidationReport): void {
  openModal({
    title: 'This plugin has problems',
    body: h('div', { class: 'plugin-report' },
      h('p', {}, 'Nothing was installed. Fix these and try again:'),
      h('ul', { class: 'plugin-report-list' },
        ...report.errors.map(e => h('li', {},
          h('code', {}, e.code),
          h('span', {}, e.message),
        )),
      ),
      report.warnings.length
        ? h('div', {},
            h('div', { class: 'plugin-review-label' }, 'Warnings'),
            h('ul', { class: 'plugin-report-list warnings' },
              ...report.warnings.map(w => h('li', {}, h('span', {}, w.message))),
            ),
          )
        : null,
    ),
  });
}

function showError(title: string, detail: string): void {
  openModal({
    title,
    body: h('div', { class: 'plugin-report' }, h('p', {}, detail)),
  });
}

/** Rust hands structured errors back as a JSON string; unwrap when possible. */
export function readableError(e: unknown): string {
  const text = String(e);
  try {
    const parsed = JSON.parse(text) as { message?: string; messages?: string[] };
    if (parsed.messages?.length) return parsed.messages.join('\n');
    if (parsed.message) return parsed.message;
  } catch {
    /* not JSON: a plain message is already readable */
  }
  return text;
}

/* ---------------- per-plugin row ---------------- */

function statusLabel(status: PluginStatus): string {
  switch (status) {
    case 'active': return 'Active';
    case 'activating': return 'Starting…';
    case 'errored': return 'Error';
    case 'disabled': return 'Disabled';
    default: return 'Not started';
  }
}

function pluginRow(
  plugin: ReturnType<typeof pluginStatuses>[number],
  rerender: () => void,
): HTMLElement {
  const actions: HTMLElement[] = [];

  actions.push(h('button', {
    class: 'btn plugin-toggle',
    type: 'button',
    onclick: () => {
      /* the loader owns both halves — the backend flag and the live slot —
         so a backend-only write left this button stuck */
      void setPluginEnabled(plugin.id, !plugin.enabled)
        .then(() => rerender())
        .catch(e => showError('Could not change that plugin', readableError(e)));
    },
  }, plugin.enabled ? 'Disable' : 'Enable'));

  if (plugin.enabled) {
    actions.push(h('button', {
      class: 'btn',
      type: 'button',
      title: 'Reload this plugin without restarting the app',
      onclick: () => {
        void reloadPlugin(plugin.id).then(() => rerender());
      },
    }, 'Reload'));
  }

  /* rollback only exists while a previous version is still on disk */
  if (plugin.previousVersion) {
    actions.push(h('button', {
      class: 'btn',
      type: 'button',
      title: `Go back to v${plugin.previousVersion}`,
      onclick: () => {
        void api.pluginRollback(plugin.id)
          .then(() => reloadPlugin(plugin.id))
          .then(() => rerender())
          .catch(e => showError('Could not roll back', readableError(e)));
      },
    }, `Roll back to v${plugin.previousVersion}`));
  }

  actions.push(h('button', {
    class: 'btn danger',
    type: 'button',
    onclick: () => void uninstallFlow(plugin, rerender),
  }, 'Uninstall'));

  /* `h()` skips null children, so the badge can be conditional inline */
  const head: (HTMLElement | string | null)[] = [
    h('span', { class: 'plugin-name' }, plugin.name),
    h('span', { class: 'plugin-version' }, 'v' + plugin.version),
    h('span', { class: 'plugin-status status-' + plugin.status }, statusLabel(plugin.status)),
    plugin.source?.kind === 'bundled'
      ? h('span', { class: 'plugin-badge' }, 'built in')
      : null,
  ];

  return h('div', { class: 'plugin-row', dataset: { plugin: plugin.id } },
    h('div', { class: 'plugin-row-head' }, ...head),
    h('div', { class: 'plugin-row-id' }, plugin.id),
    plugin.error ? h('div', { class: 'plugin-error' }, plugin.error) : null,
    h('div', { class: 'plugin-row-actions' }, ...actions),
  );
}

/**
 * Uninstall keeps plugin data by default. Losing a user's notes to a
 * mis-click is not an acceptable default, so removal is a separate,
 * explicitly-chosen action (docs/PLUGIN_PLATFORM.md §8).
 */
function uninstallFlow(
  plugin: ReturnType<typeof pluginStatuses>[number],
  rerender: () => void,
): Promise<void> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (v: boolean): void => {
      if (settled) return;
      settled = true;
      modal.close();
      resolve();
    };

    const removeData = h('input', { type: 'checkbox', id: 'plugin-remove-data' }) as HTMLInputElement;

    const modal = openModal({
      title: 'Uninstall ' + plugin.name + '?',
      body: h('div', { class: 'plugin-review' },
        h('p', {}, 'The plugin stops running and its files are removed.'),
        h('label', { class: 'plugin-check', for: 'plugin-remove-data' },
          removeData,
          h('span', {}, 'Also delete its saved data'),
        ),
        h('p', { class: 'plugin-review-note' },
          'Its saved data is kept unless you tick this, so reinstalling the plugin restores your setup.'),
      ),
      footer: h('div', { class: 'plugin-review-foot' },
        h('button', { class: 'btn', type: 'button', onclick: () => finish(false) }, 'Cancel'),
        h('button', {
          class: 'btn danger',
          type: 'button',
          onclick: () => {
            void api.pluginUninstall(plugin.id, removeData.checked)
              .then(() => {
                /* the backend dropped the record; the host still holds the
                   slot, and every contribution surface is driven by it */
                forgetPlugin(plugin.id);
                finish(true);
                rerender();
              })
              .catch(e => showError('Could not uninstall', readableError(e)));
          },
        }, 'Uninstall'),
      ),
      onClose: () => finish(false),
    });
  });
}
