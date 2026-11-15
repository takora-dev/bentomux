import { describe, it, expect } from 'vitest';
import { setDb, getProfiles, activeProfile, visibleWorkspaces } from '../store';
import type { AppState } from '../../shared/types';

describe('workspace profiles store helpers', () => {
  const baseState: AppState = {
    version: 6,
    workspaces: [
      { id: 'ws-1', name: 'Freelance App', path: '/code/freelance' },
      { id: 'ws-2', name: 'Work Project', path: '/code/work' },
      { id: 'ws-3', name: 'Personal Blog', path: '/code/blog' },
    ],
    prefs: { theme: 'dark', palette: 'tokyo-night' },
    activeWorkspaceId: 'ws-1',
    openTabs: [],
    shadow: {},
    agents: [],
    plugins: [],
  };

  it('fallback when db.profiles is undefined', () => {
    setDb({ ...baseState, profiles: undefined, activeProfileId: undefined });
    const profs = getProfiles();
    expect(profs).toHaveLength(1);
    expect(profs[0].name).toBe('Default Workspace');
    expect(profs[0].workspaceIds).toEqual(['ws-1', 'ws-2', 'ws-3']);

    const active = activeProfile();
    expect(active.id).toBe('default');

    const visible = visibleWorkspaces();
    expect(visible.map(w => w.id)).toEqual(['ws-1', 'ws-2', 'ws-3']);
  });

  it('filters visible workspaces by active profile', () => {
    setDb({
      ...baseState,
      profiles: [
        { id: 'prof-freelance', name: 'Freelance', workspaceIds: ['ws-1'] },
        { id: 'prof-work', name: 'Work', workspaceIds: ['ws-2', 'ws-3'] },
      ],
      activeProfileId: 'prof-freelance',
    });

    expect(activeProfile().id).toBe('prof-freelance');
    expect(visibleWorkspaces().map(w => w.id)).toEqual(['ws-1']);

    // Switch to work profile
    setDb({
      ...baseState,
      profiles: [
        { id: 'prof-freelance', name: 'Freelance', workspaceIds: ['ws-1'] },
        { id: 'prof-work', name: 'Work', workspaceIds: ['ws-2', 'ws-3'] },
      ],
      activeProfileId: 'prof-work',
    });

    expect(activeProfile().id).toBe('prof-work');
    expect(visibleWorkspaces().map(w => w.id)).toEqual(['ws-2', 'ws-3']);
  });

  it('handles empty workspace profile gracefully', () => {
    setDb({
      ...baseState,
      profiles: [
        { id: 'prof-empty', name: 'Empty Profile', workspaceIds: [] },
      ],
      activeProfileId: 'prof-empty',
    });

    expect(activeProfile().name).toBe('Empty Profile');
    expect(visibleWorkspaces()).toEqual([]);
  });

  it('moves workspace from one profile to another', () => {
    const state: AppState = {
      ...baseState,
      profiles: [
        { id: 'prof-freelance', name: 'Freelance', workspaceIds: ['ws-1'] },
        { id: 'prof-work', name: 'Work', workspaceIds: ['ws-2', 'ws-3'] },
      ],
      activeProfileId: 'prof-freelance',
    };
    setDb(state);

    expect(visibleWorkspaces().map(w => w.id)).toEqual(['ws-1']);

    // Simulate move ws-1 to prof-work
    const updatedProfiles = state.profiles!.map(p => {
      if (p.id === 'prof-freelance') {
        return { ...p, workspaceIds: p.workspaceIds.filter(id => id !== 'ws-1') };
      }
      if (p.id === 'prof-work') {
        return { ...p, workspaceIds: [...p.workspaceIds, 'ws-1'] };
      }
      return p;
    });

    setDb({
      ...state,
      profiles: updatedProfiles,
    });

    // In prof-freelance, ws-1 is now gone
    expect(visibleWorkspaces()).toEqual([]);

    // When switching to prof-work, ws-1 is present
    setDb({
      ...state,
      profiles: updatedProfiles,
      activeProfileId: 'prof-work',
    });

    expect(visibleWorkspaces().map(w => w.id)).toEqual(['ws-1', 'ws-2', 'ws-3']);
  });

  it('scoped workspace removal does not affect other profiles sharing the workspace', () => {
    // Both prof-a and prof-b share ws-1
    const state: AppState = {
      ...baseState,
      profiles: [
        { id: 'prof-a', name: 'Profile A', workspaceIds: ['ws-1', 'ws-2'] },
        { id: 'prof-b', name: 'Profile B', workspaceIds: ['ws-1'] },
      ],
      activeProfileId: 'prof-b',
    };
    setDb(state);

    expect(visibleWorkspaces().map(w => w.id)).toEqual(['ws-1']);

    // Remove ws-1 while active in prof-b
    const updatedProfiles = state.profiles!.map(p => {
      if (p.id === 'prof-b') {
        return { ...p, workspaceIds: p.workspaceIds.filter(id => id !== 'ws-1') };
      }
      return p;
    });

    setDb({
      ...state,
      profiles: updatedProfiles,
      activeProfileId: 'prof-b',
    });

    // In prof-b, ws-1 is gone
    expect(visibleWorkspaces()).toEqual([]);

    // In prof-a, ws-1 is STILL PRESENT!
    setDb({
      ...state,
      profiles: updatedProfiles,
      activeProfileId: 'prof-a',
    });
    expect(visibleWorkspaces().map(w => w.id)).toEqual(['ws-1', 'ws-2']);
  });
});
