# Context API reference

Generated from `src/src/plugin/types.ts` — do not edit by hand.

`activate(ctx)` receives this object:

```ts
export interface PluginContext {
  readonly plugin: { id: string; version: string };
  readonly log: (...args: unknown[]) => void;
  readonly storage: PluginStorage;
  readonly app: Record<string, (...args: never[]) => unknown>;
  readonly events: PluginEvents;
  readonly ui: PluginUi;
  /** Register teardown work; every entry runs on deactivate. */
  readonly dispose: (fn: Cleanup) => void;
}
```

## Registering contributions

```ts
export interface PluginUi {
  /** Register the handler for a command the manifest declared. */
  command(id: string, handler: (args?: unknown) => void | Promise<void>): void;
  /** Register the body renderer for a tab the manifest declared. */
  tab(id: string, render: RenderFn): void;
  modal(id: string, render: RenderFn): void;
  widget(id: string, render: RenderFn): void;
  settingsSection(id: string, build: (paint: () => void) => HTMLElement): void;
  /** Register a background service. Started at boot for plugins that declare one. */
  service(id: string, run: (signal: AbortSignal) => void | Promise<void>): void;

  /**
   * Open a tab this plugin declared. Declaring a tab puts it in the tab
   * strip's add menu; a command handler calls this to open it. Throws when
   * the id was never declared or no renderer is registered for it.
   */
  openTab(id: string): void;
  /** Open a modal this plugin declared, rendered into the app's modal root. */
  openModal(id: string): void;
}
```

Every id passed to a registration call must already be declared in
`plugin.json`. Registering an undeclared id is an error; declaring an id that
is never registered is a warning. That pairing is what keeps a manifest an
honest description of what the plugin adds.

The render callbacks for tabs, modals, and widgets take the host element to
fill, and may return a cleanup function that runs when that surface is torn
down.

## Storage

```ts
export interface PluginStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}
```

Values must be JSON-serializable. The store is one file per plugin, capped at
1 MB, and it **survives uninstall** unless the user explicitly asks for its
removal.

## Events

```ts
export interface PluginEvents {
  on(event: 'workspace:changed', cb: (payload: PluginHostEventPayloads['workspace:changed']) => void): Cleanup;
  on(event: 'tab:activated', cb: (payload: PluginHostEventPayloads['tab:activated']) => void): Cleanup;
  on(event: 'tab:closed', cb: (payload: PluginHostEventPayloads['tab:closed']) => void): Cleanup;
}
```

The host fires `workspace:changed`, `tab:activated`, and `tab:closed`.

## Teardown

Return nothing from `activate`; register cleanup with `ctx.dispose(fn)` or by
returning a function from a render callback. ES modules cannot be unloaded, so
a plugin that does not release its listeners and DOM will keep them after it is
disabled.
