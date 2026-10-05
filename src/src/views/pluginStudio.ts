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
import { openUrl } from '@tauri-apps/plugin-opener';
import { openModal } from '../components/modal';
import {
  pluginStatuses,
  reloadPlugin,
  forgetPlugin,
  setPluginEnabled,
  onPluginsChanged,
  type PluginStatus,
} from '../plugin/loader';
import { describeNetwork, describePermissions } from '../plugin/facade';
import { restartApp } from '../updates';
import type {
  PluginManifest,
  PluginPermission,
  PluginRecord,
  ValidationReport,
  MarketplacePlugin,
  MarketplaceCatalog,
} from '../plugin/types';
import { CONTRIBUTION_KINDS } from '../plugin/types';
import { filterPlugins, paginate } from '../../shared/marketplace';

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
      title: 'Browse plugins published to the Bentomux catalog',
      onclick: () => void marketplaceFlow(rerender),
    }, 'Browse marketplace…'),
    h('button', {
      class: 'btn',
      type: 'button',
      title: 'Install the bentomux-plugin-author skill into your agent so it can write plugins for you',
      onclick: () => void installSkillFlow(),
    }, 'Install authoring skill…'),
  );
}

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
  kind: 'folder' | 'zip' | 'marketplace',
  rerender: () => void,
  /** Provenance for `marketplace`: the GitHub repo the install came from.
      Omitted for the hand-picked sources, which have none. */
  source?: { repo: string; url: string },
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
    let record: PluginRecord;
    if (kind === 'folder') {
      record = await api.pluginInstallFolder(path);
    } else if (kind === 'zip') {
      record = await api.pluginInstallZip(path);
    } else {
      /* the marketplace command exists only to record the repo, which is what
         makes later releases matchable to this install */
      if (!source) throw new Error('a marketplace install needs its repo');
      record = await api.pluginMarketplaceInstall(path, source.repo, source.url);
    }
    await reloadPlugin(record.id);
    rerender();
    /* a plugin the host already knows reloads in place; a brand-new one only
       joins the loaded set at boot, so the user is told to restart */
    if (!knownBefore.has(record.id)) showRestartNotice(manifest.name);
  } catch (e) {
    showError('Install failed', readableError(e));
  }
}

/* ---------------- marketplace ---------------- */

/**
 * Browse the marketplace.
 *
 * GitHub is the catalog: every repo tagged `bentomux-plugin` shows up, sorted
 * by stars, and installing takes its release asset. There is no server and no
 * submission step — push a repo with the topic and a release with a `.zip`, and
 * the plugin is listed.
 *
 * A modal rather than a Studio tab, because this is a browsing surface with
 * nothing to do until the user picks something — the same reason the existing
 * install flow opens modals instead of swapping views.
 *
 * Installing from here runs the ordinary flow unchanged: download to a temp
 * file with the published digest checked, then `reviewAndInstall` over that
 * path. Validation, the permissions/contributions review, and the restart
 * notice are the same code the folder and zip paths already use, so a
 * marketplace install gets no shortcut and no extra trust.
 */
async function marketplaceFlow(rerender: () => void): Promise<void> {
  const body = h('div', { class: 'plugin-market' }, loadingRow());

  const modal = openModal({
    title: 'Plugin marketplace',
    size: 'wide',
    body,
    footer: h('div', { class: 'plugin-review-foot' },
      h('button', { class: 'btn', type: 'button', onclick: () => modal.close() }, 'Close'),
    ),
  });
  const close = (): void => modal.close();

  await loadCatalog(body, rerender, close);
}

/**
 * Fetch the catalog and paint it, optionally forcing a fresh sweep.
 *
 * The response is re-read after every install and update, because the backend
 * joins it against the app's own registry — so a plugin that just landed shows
 * as installed without this side guessing anything from the repo name.
 */
async function loadCatalog(
  body: HTMLElement,
  rerender: () => void,
  close: () => void,
  force = false,
): Promise<void> {
  replaceBody(body, loadingRow());
  try {
    const catalog = await api.pluginMarketplaceIndex(force);
    renderCatalog(body, catalog, rerender, close, () => loadCatalog(body, rerender, close, true));
  } catch (e) {
    replaceBody(body, h('p', { class: 'plugin-empty' }, readableError(e)));
  }
}

/**
 * Paint the catalog.
 *
 * The toolbar is built once and never replaced; only the list and the pager
 * are repainted. That split exists for the search field: replacing the input
 * node on every keystroke drops focus and eats the second half of the word.
 *
 * Filtering and slicing live in `shared/marketplace` because the clamping and
 * boundary cases are easy to get wrong and easy to test there.
 */
function renderCatalog(
  body: HTMLElement,
  catalog: MarketplaceCatalog,
  rerender: () => void,
  close: () => void,
  reload: () => Promise<void>,
): void {
  const state = { query: '', page: 0 };
  const list = h('div', { class: 'plugin-market-list' });
  const pager = h('div', { class: 'plugin-market-pager' });

  const paint = (): void => {
    const found = filterPlugins(catalog.plugins, state.query);
    const view = paginate(found, state.page);
    state.page = view.page;

    const rows: (HTMLElement | null)[] = [];
    if (!view.total) {
      const q = state.query.trim();
      rows.push(h('p', { class: 'plugin-empty' },
        q
          ? `Nothing matches “${q}”.`
          : 'No plugins published yet. Add the topic "bentomux-plugin" to your ' +
            'repo and publish a release with a .zip asset.'));
      if (q) {
        rows.push(h('button', {
          class: 'btn',
          type: 'button',
          onclick: () => { state.query = ''; state.page = 0; field.value = ''; paint(); },
        }, 'Clear search'));
      }
    } else {
      for (const plugin of view.items) rows.push(marketplaceRow(plugin, rerender, close));
    }
    replaceBody(list, rows);

    replaceBody(pager, view.pages > 1
      ? [
          h('button', {
            class: 'btn',
            type: 'button',
            disabled: view.page === 0,
            onclick: () => { state.page -= 1; paint(); },
          }, '‹ Previous'),
          h('span', { class: 'plugin-market-page' },
            `Page ${view.page + 1} of ${view.pages}`),
          h('button', {
            class: 'btn',
            type: 'button',
            disabled: view.page >= view.pages - 1,
            onclick: () => { state.page += 1; paint(); },
          }, 'Next ›'),
        ]
      : []);
  };

  const field = h('input', {
    class: 'plugin-market-search',
    type: 'search',
    placeholder: 'Search plugins',
    'aria-label': 'Search plugins',
    oninput: (e: Event) => {
      state.query = (e.target as HTMLInputElement).value;
      state.page = 0;
      paint();
    },
  }) as HTMLInputElement;

  paint();
  replaceBody(body, [
    catalogLine(catalog, reload),
    h('div', { class: 'plugin-market-bar' },
      h('label', { class: 'plugin-market-search-wrap' },
        h('span', { class: 'plugin-market-search-icon', 'aria-hidden': 'true' }, '⌕'),
        field,
      ),
      h('span', { class: 'plugin-market-count' },
        `${catalog.plugins.length} in catalog`),
    ),
    list,
    pager,
  ]);
}

/**
 * The freshness line and the refresh control.
 *
 * A stale catalog says so and says why. Showing six-hour-old stars as if they
 * were live would be a small lie, and it is exactly the lie that makes a user
 * distrust a "Downloads: 12" figure.
 *
 * Refresh is disabled while it runs, and that is not polish. One forced sweep
 * costs one search plus one release call per repo — up to 31 of GitHub's 60
 * unauthenticated requests an hour. A double-click would spend half the day's
 * budget and leave the marketplace stale for the next six hours.
 */
function catalogLine(catalog: MarketplaceCatalog, reload: () => Promise<void>): HTMLElement {
  const when = catalog.fetchedAt
    ? new Date(catalog.fetchedAt).toLocaleString()
    : 'never';

  const button = h('button', {
    class: 'btn plugin-market-refresh',
    type: 'button',
    title: 'Re-check GitHub now',
  }, '↻ Refresh') as HTMLButtonElement;

  button.addEventListener('click', () => {
    button.disabled = true;
    button.textContent = '↻ Refreshing…';
    void reload();
  });

  return h('div', { class: 'plugin-market-line' },
    h('span', { class: 'plugin-market-when' }, `Updated ${when}`),
    catalog.stale
      ? h('span', { class: 'plugin-badge', title: catalog.staleReason },
          catalog.staleReason ? 'saved copy — ' + firstLine(catalog.staleReason) : 'saved copy')
      : null,
    button,
  );
}

function marketplaceRow(
  plugin: MarketplacePlugin,
  rerender: () => void,
  close: () => void,
): HTMLElement {
  /** Download and verify, so the review screen runs over real bytes. */
  const download = async (): Promise<string | null> => {
    try {
      return await api.pluginFetchUrl(plugin.downloadUrl, plugin.sha256);
    } catch (e) {
      showError('Download failed', readableError(e));
      return null;
    }
  };

  /**
   * A first install goes through the ordinary review screen. An update does
   * too: new code can ask for permissions the old code did not, and the user
   * should see that before it runs, not after.
   */
  const install = async (): Promise<void> => {
    close();
    const path = await download();
    if (!path) return;
    /* 'zip': the temp file is a zip, and going through reviewAndInstall is
       the point — the review screen is what makes a remote install
       trustworthy. `source` is what records the repo. */
    await reviewAndInstall(path, 'marketplace', rerender, {
      repo: plugin.repo,
      url: plugin.downloadUrl,
    });
  };

  const update = async (): Promise<void> => {
    close();
    const path = await download();
    if (!path) return;

    let manifest: PluginManifest;
    let report: ValidationReport;
    try {
      report = await api.pluginValidate(path, false);
      if (!report.ok || !report.manifest) {
        showValidationReport(report);
        return;
      }
      manifest = report.manifest;
    } catch (e) {
      showError('Could not read that release', String(e));
      return;
    }

    if (!await confirmInstall(manifest, report, 'Update')) return;

    try {
      const record = await api.pluginMarketplaceUpdate(
        path, plugin.sha256, plugin.repo, plugin.downloadUrl,
      );
      await reloadPlugin(record.id);
      rerender();
      /* Update keeps the previous version as the rollback target, so the row
         now offers a way back that the plugin did not have before. */
      showUpdated(manifest.name, record.previousVersion ?? null);
    } catch (e) {
      showError('Update failed', readableError(e));
    }
  };

  const label = plugin.updateAvailable
    ? `Update to ${plugin.version}`
    : plugin.installed ? 'Reinstall' : 'Install';

  return h('div', { class: 'plugin-row' },
    h('div', { class: 'plugin-row-head' },
      h('span', { class: 'plugin-name' }, plugin.name),
      plugin.version ? h('span', { class: 'plugin-version' }, plugin.version) : null,
      plugin.installed
        ? h('span', { class: 'plugin-badge' }, 'v' + plugin.installedVersion + ' installed')
        : null,
      plugin.updateAvailable
        ? h('span', { class: 'plugin-status status-active' }, 'update available')
        : null,
    ),
    plugin.description ? h('p', { class: 'plugin-review-desc' }, plugin.description) : null,
    h('div', { class: 'plugin-market-stats' },
      h('span', { title: 'GitHub stars' }, `★ ${plugin.stars.toLocaleString()}`),
      h('span', { title: 'GitHub downloads of the release asset' },
        `↓ ${plugin.downloads.toLocaleString()}`),
      h('span', { class: 'plugin-row-id' }, plugin.repo),
    ),
    plugin.installable
      ? null
      : h('p', { class: 'plugin-market-note' }, plugin.note),
    h('div', { class: 'plugin-row-actions' },
      h('button', {
        class: 'btn primary',
        type: 'button',
        disabled: !plugin.installable,
        onclick: () => void (plugin.updateAvailable ? update() : install()),
      }, label),
      h('button', {
        class: 'btn',
        type: 'button',
        onclick: () => showPluginDetails(plugin),
      }, 'Details & README'),
      h('button', {
        class: 'btn',
        type: 'button',
        title: 'Open the repository on GitHub',
        onclick: () => void openUrl(plugin.htmlUrl).catch((e: unknown) => {
          showError('Could not open GitHub', readableError(e));
        }),
      }, 'GitHub'),
    ),
  );
}

/**
 * Say the plugin updated, and name the way back.
 *
 * `commit_update` keeps exactly one previous version on disk, so this is the
 * only moment the user is told the escape hatch exists. After a third version
 * arrives the older directory is garbage-collected, and the Roll back button in
 * the plugin list becomes the only route.
 */
function showUpdated(pluginName: string, previousVersion: string | null): void {
  openModal({
    title: 'Updated ' + pluginName,
    body: h('div', { class: 'plugin-review' },
      h('p', {},
        pluginName + ' is updated and reloaded. Any open tab it owns was torn ' +
        'down and rebuilt by the reload.'),
      previousVersion
        ? h('p', { class: 'plugin-review-note' },
            `v${previousVersion} is kept on disk as your rollback target. Roll back from the ` +
            'plugin list in Settings → Plugins if the new version misbehaves.')
        : h('p', { class: 'plugin-review-note' }, 'No earlier version was on disk to roll back to.'),
    ),
  });
}

/* ---------------- plugin details ---------------- */

/**
 * The details view: what GitHub reports, plus the plugin's README.
 *
 * The README is fetched here rather than during the sweep — one README per
 * plugin would double the GitHub request count for text nobody opened yet. It
 * is shown as plain text in a scrollable block, not rendered: `dom.ts`
 * reserves `innerHTML` for compile-time constants and forbids file content, so
 * rendering a third-party README to HTML would mean writing an HTML sanitizer
 * to make it safe. Plain text is the whole fix.
 */
async function showPluginDetails(plugin: MarketplacePlugin): Promise<void> {
  /* The catalog list stays open behind this one: a README is a peek, and
     closing the list to read it then making the user reopen it would be
     worse than two stacked overlays. openModal appends, so the details
     dialog sits on top and its own close() is safe to call twice. */
  const readmeBlock = h('pre', { class: 'plugin-readme' }, 'Loading README…');
  const modal = openModal({
    title: plugin.name,
    body: h('div', { class: 'plugin-review' },
      h('div', { class: 'plugin-review-id' }, plugin.repo + (plugin.version ? ' · ' + plugin.version : '')),
      plugin.description ? h('p', { class: 'plugin-review-desc' }, plugin.description) : null,
      h('div', { class: 'plugin-review-block' },
        h('div', { class: 'plugin-review-label' }, 'GitHub'),
        h('p', { class: 'plugin-review-none' },
          `★ ${plugin.stars.toLocaleString()} stars · ` +
          `↓ ${plugin.downloads.toLocaleString()} downloads of ${plugin.assetName || 'the asset'}`),
      ),
      plugin.installable
        ? h('div', { class: 'plugin-review-block' },
            h('div', { class: 'plugin-review-label' }, 'sha256'),
            h('div', { class: 'plugin-review-id' }, plugin.sha256),
          )
        : h('p', { class: 'plugin-market-note' }, plugin.note),
      h('div', { class: 'plugin-review-block' },
        h('div', { class: 'plugin-review-label' }, 'README'),
        readmeBlock,
      ),
      h('p', { class: 'plugin-review-note' },
        'Permissions and contributions are read from the plugin’s own manifest when you ' +
        'install, not from this page — the review screen shows them before anything runs.'),
    ),
    footer: h('div', { class: 'plugin-review-foot' },
      h('button', { class: 'btn', type: 'button', onclick: () => modal.close() }, 'Close'),
    ),
  });

  try {
    const text = await api.pluginMarketplaceReadme(plugin.repo, plugin.version);
    readmeBlock.textContent = text.trim() || '(this repo has no README.md)';
  } catch (e) {
    readmeBlock.textContent = 'Could not load the README: ' + readableError(e);
  }
}

/* ---------------- small helpers ---------------- */

function loadingRow(): HTMLElement {
  return h('p', { class: 'plugin-empty' }, 'Loading plugins from GitHub…');
}

function replaceBody(body: HTMLElement, kids: HTMLElement | (HTMLElement | null)[]): void {
  body.replaceChildren(...(Array.isArray(kids) ? kids : [kids]).filter(
    (k): k is HTMLElement => k !== null,
  ));
}

/** First line of a Rust error string, trimmed of the `{"code":…}` wrapper. */
function firstLine(s: string): string {
  const text = s.replace(/\{"code":"[^"]*","message":"/, '').replace(/"\}\s*$/, '');
  const cut = text.indexOf('. ');
  return (cut > 0 ? text.slice(0, cut + 1) : text).slice(0, 90);
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

function confirmInstall(
  manifest: PluginManifest,
  report: ValidationReport,
  verb = 'Install',
): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (v: boolean): void => {
      if (settled) return;
      settled = true;
      modal.close();
      resolve(v);
    };

    const modal = openModal({
      title: verb + ' ' + manifest.name + '?',
      body: h('div', { class: 'plugin-review' },
        h('div', { class: 'plugin-review-id' }, manifest.id + ' · v' + manifest.version),
        manifest.description ? h('p', { class: 'plugin-review-desc' }, manifest.description) : null,
        contributionSummary(manifest),
        permissionSummary(manifest),
        networkSummary(manifest),
        report.warnings.length ? warningList(report.warnings.map(w => w.message)) : null,
      ),
      footer: h('div', { class: 'plugin-review-foot' },
        h('button', { class: 'btn', type: 'button', onclick: () => finish(false) }, 'Cancel'),
        h('button', { class: 'btn primary', type: 'button', onclick: () => finish(true) }, verb),
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

function networkSummary(manifest: PluginManifest): HTMLElement | null {
  const described = describeNetwork(manifest.network);
  if (!described.length) return null;
  return h('div', { class: 'plugin-review-block' },
    h('div', { class: 'plugin-review-label' }, 'It can reach'),
    h('ul', { class: 'plugin-review-list' }, ...described.map(d => h('li', {}, d))),
    h('p', { class: 'plugin-review-note' },
      'These sites are baked into the app at build time — a plugin installed ' +
      'later can only use the ones its release already allows.'),
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
