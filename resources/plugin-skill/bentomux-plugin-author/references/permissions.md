# Permissions reference

Generated from `src/src/plugin/types.ts` — do not edit by hand.

Every capability a plugin uses must be declared in `plugin.json` first. The
host hands over only what was declared; calling an undeclared method throws a
named error rather than working by accident.

| Permission | Unlocks |
|---|---|
| `storage` | `ctx.storage` (get / set / delete / keys) |
| `app.read` | `ctx.app.getState`, `ctx.app.onBranch`, `ctx.app.onRuntimeStatus`, `ctx.app.onAgentEvent`, `ctx.app.onAgentApproval`, `ctx.app.onAgentApprovalClosed`, `ctx.app.onFileDrop` |
| `app.prefs.write` | `ctx.app.setPrefs` |
| `app.window` | `ctx.app.minimize`, `ctx.app.toggleMaximize`, `ctx.app.toggleFullscreen`, `ctx.app.close`, `ctx.app.onMaximized`, `ctx.app.quitApp` |
| `files.temp` | `ctx.app.saveTempFile` |
| `workspaces.write` | `ctx.app.chooseFolder`, `ctx.app.addWorkspace`, `ctx.app.removeWorkspace`, `ctx.app.reorderWorkspaces`, `ctx.app.setActiveWorkspace` |
| `tabs.write` | `ctx.app.createTab`, `ctx.app.splitTab`, `ctx.app.setSplitDir`, `ctx.app.renameTab`, `ctx.app.closePane`, `ctx.app.closeTab`, `ctx.app.setActiveTab` |
| `terminal.read` | `ctx.app.onPtyData`, `ctx.app.onPtyExit` |
| `terminal.input` | `ctx.app.writeTab`, `ctx.app.resizeTab` |
| `git.read` | `ctx.app.branchFor`, `ctx.app.gitStatus`, `ctx.app.gitDiff`, `ctx.app.gitDiffStat`, `ctx.app.gitRemoteInfo` |
| `git.push` | `ctx.app.gitPush` |
| `agents.read` | `ctx.app.agents`, `ctx.app.agentConfig`, `ctx.app.listResources`, `ctx.app.agentHooksStatus` |
| `agents.write` | `ctx.app.setAgentModelSettings`, `ctx.app.saveResource`, `ctx.app.deleteResource`, `ctx.app.toggleResource`, `ctx.app.agentHooksInstall`, `ctx.app.agentHooksUninstall`, `ctx.app.resolveApproval` |
| `remote.control` | `ctx.app.remoteInfo`, `ctx.app.remoteSetEnabled`, `ctx.app.remoteSetPort` |
| `backend.invoke` | `ctx.app.invoke(command, args)`, restricted to the allowlist below |

## `backend.invoke` allowlist

`ctx.app.invoke(command, args)` forwards only these, and they are read-only:

- `get_state`
- `git_status`
- `git_diff`
- `git_diff_stat`
- `git_remote_info`
- `git_branch_for`
- `agents_list`
- `agents_config`
- `res_list`
- `agent_hooks_status`
- `remote_info`

## What permissions are not

They are a **contract, not a sandbox**. Plugin code runs inside Bentomux and
shares its JavaScript realm, so a plugin is not isolated from the app. The
permission list makes a plugin's intent legible to the user and checkable by
the validator — it does not contain a hostile plugin. Do not describe it to a
user as a security boundary.
