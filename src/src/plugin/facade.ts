/* ---------------- plugin host: permission-scoped app facade ----------------
   Spec: docs/PLUGIN_PLATFORM.md §5–§6. Decision: docs/adr/0001.

   Builds the object a plugin receives as `ctx.app`, exposing only the bridge
   methods its manifest's permissions unlock.

   This is NOT a security boundary and must not be described as one anywhere:
   plugin code runs in this realm and shares its globals, so a plugin that
   wants the full bridge can reach it. What this buys is that a call the
   manifest did not declare **throws a named error** instead of working by
   accident — so the mistake is loud during development, and the Studio review
   screen can show a user exactly which parts of the app a plugin asked for. */

import api from '../../preload/bentomux';
import { raw } from '../../preload/bentomux';
import {
  BACKEND_ALLOWLIST,
  PERMISSION_METHODS,
  type PluginPermission,
} from './types';

/** Raised when a plugin calls a bridge method its manifest did not unlock. */
export class PermissionError extends Error {
  constructor(pluginId: string, method: string, permission: string | null) {
    super(
      permission
        ? `plugin \`${pluginId}\` called \`${method}\`, which needs the \`${permission}\` permission — add it to plugin.json`
        : `plugin \`${pluginId}\` called \`${method}\`, which no permission unlocks`,
    );
    this.name = 'PermissionError';
  }
}

/** method name → the permission that unlocks it. Built once, inverted. */
const METHOD_PERMISSION: Map<string, PluginPermission> = (() => {
  const map = new Map<string, PluginPermission>();
  for (const [permission, methods] of Object.entries(PERMISSION_METHODS) as [PluginPermission, string[]][]) {
    for (const method of methods) {
      /* first writer wins; the tables above are disjoint by construction */
      if (!map.has(method)) map.set(method, permission);
    }
  }
  return map;
})();

const bridge = api as unknown as Record<string, unknown>;

/**
 * Build the facade for one plugin.
 *
 * Every bridge method the permissions allow is bound to the real bridge; every
 * method that exists but was not unlocked becomes a thrower. Methods that do
 * not exist at all are omitted, so a typo surfaces as "not a function" rather
 * than as a permission error that would send the author down the wrong path.
 */
export function buildAppFacade(
  pluginId: string,
  permissions: PluginPermission[],
): Record<string, (...args: never[]) => unknown> {
  const granted = new Set(permissions);
  const facade: Record<string, (...args: never[]) => unknown> = {};

  /* 1. the unlocked surface: real methods, bound so `this` stays correct */
  for (const [method, permission] of METHOD_PERMISSION) {
    if (!granted.has(permission)) continue;
    const fn = bridge[method];
    if (typeof fn !== 'function') continue;
    facade[method] = (fn as (...a: unknown[]) => unknown).bind(api) as (...args: never[]) => unknown;
  }

  /* 2. the locked surface: named throwers, so the failure explains itself */
  for (const [method, permission] of METHOD_PERMISSION) {
    if (granted.has(permission)) continue;
    if (typeof bridge[method] !== 'function') continue;
    facade[method] = (() => {
      throw new PermissionError(pluginId, method, permission);
    }) as unknown as (...args: never[]) => unknown;
  }

  /* 3. the generic backend passthrough, allowlisted in Rust as well */
  if (granted.has('backend.invoke')) {
    facade['invoke'] = ((command: string, args?: Record<string, unknown>) => {
      if (!BACKEND_ALLOWLIST.includes(command)) {
        throw new Error(
          `plugin \`${pluginId}\` tried to invoke \`${command}\`, which is not on the backend allowlist`,
        );
      }
      return raw.invoke(command, args);
    }) as unknown as (...args: never[]) => unknown;
  }

  return facade;
}

/** For the Studio review screen: which outside websites a plugin may reach. */
export function describeNetwork(network: string[] | undefined): string[] {
  return (network ?? []).map(h => `Talk to ${h}`);
}

/** For the Studio review screen: what a permission set adds up to. */
export function describePermissions(permissions: PluginPermission[]): string[] {
  const out: string[] = [];
  for (const permission of permissions) {
    const methods = PERMISSION_METHODS[permission] ?? [];
    if (permission === 'storage') {
      out.push('Store its own data (kept if you uninstall it)');
    } else if (permission === 'backend.invoke') {
      out.push('Read app data through a fixed allowlist of commands');
    } else if (methods.length) {
      out.push(`${permission}: ${methods.join(', ')}`);
    }
  }
  return out;
}
