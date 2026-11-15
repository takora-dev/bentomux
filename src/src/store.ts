/* ---------------- client-side cache of main-process state ---------------- */

import type { AppState, RuntimeStatus, WorkspaceProfile, WorkspaceRec } from '../shared/types';

export let db: AppState;

export function setDb(next: AppState): void {
  db = next;
}

export function getProfiles(): WorkspaceProfile[] {
  if (db?.profiles && db.profiles.length > 0) {
    return db.profiles;
  }
  return [{
    id: 'default',
    name: 'Default Workspace',
    workspaceIds: (db?.workspaces || []).map(w => w.id),
  }];
}

export function activeProfile(): WorkspaceProfile {
  const list = getProfiles();
  return list.find(p => p.id === db?.activeProfileId) || list[0];
}

export function visibleWorkspaces(): WorkspaceRec[] {
  if (!db?.workspaces) return [];
  const prof = activeProfile();
  const idSet = new Set(prof.workspaceIds);
  return db.workspaces.filter(w => idSet.has(w.id));
}

/* git branch per workspace id */
export const branches = new Map<string, string | null>();

/* agent runtime status per terminal tab id */
export const runtime: Record<string, RuntimeStatus> = {};

/* last output activity per terminal tab id (drives the relative time) */
export const activity: Record<string, number> = {};
