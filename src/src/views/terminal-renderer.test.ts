import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { loadGpuRenderer } from './terminal';

/* xterm 6.0.0 ships only the DOM renderer: every frame it rebuilds the
   painted rows as real DOM nodes, and the WebView re-lays-out and re-paints
   that text through WebCore. On a busy pane that is the renderer's dominant
   cost — measured on the production WebContent process, WebCore layout and
   paint was 76% of its time, and swapping the renderer removed it.

   Three things have to hold for that to be safe:
   - the addon is loaded, so the pane does not sit on the DOM renderer on a
     machine that supports WebGL2;
   - a machine that cannot give us a WebGL2 context still gets a working
     terminal, because xterm keeps the DOM renderer it already installed;
   - the WebGL2 context is released when the pane goes away, because
     upstream xtermjs/xterm.js#6068 leaves it alive and the browser then
     evicts the oldest context — which belongs to a pane still on screen.

   The addon needs a real WebGL2 context, which happy-dom does not provide,
   so it is mocked here and the contract around it is what is pinned. */

type FakeGl = {
  loseContext: Mock<() => void>;
  getExtension: Mock<(name: string) => { loseContext: () => void } | null>;
};

let contextLossHandler: (() => void) | undefined;
let addonCtor: () => void;
/* the addon's own dispose, kept separate from `mockAddon.dispose`: the
   loader replaces that property with a wrapper, and the wrapper is what
   has to be able to reach the original */
let disposeSpy: Mock<() => void>;
let mockAddon: {
  activate: Mock<() => void>;
  dispose: () => void;
  onContextLoss: Mock<(cb: () => void) => void>;
  _renderer?: { _gl?: FakeGl };
};

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    constructor() {
      addonCtor();
      return mockAddon as never;
    }
  }
}));

/* a context that answers the extension the loader asks for */
function fakeGl(): FakeGl {
  const loseContext = vi.fn<() => void>();
  const getExtension = vi.fn<(name: string) => { loseContext: () => void } | null>(() => ({
    loseContext
  }));
  return { loseContext, getExtension };
}

describe('loadGpuRenderer()', () => {
  beforeEach(() => {
    contextLossHandler = undefined;
    addonCtor = () => {};
    disposeSpy = vi.fn<() => void>();
    mockAddon = {
      activate: vi.fn<() => void>(),
      dispose: disposeSpy,
      onContextLoss: vi.fn<(cb: () => void) => void>((cb: () => void) => {
        contextLossHandler = cb;
      })
    };
  });

  it('loads the WebGL addon onto the terminal', () => {
    const term = { loadAddon: vi.fn() };
    loadGpuRenderer(term as never);
    expect(term.loadAddon).toHaveBeenCalledTimes(1);
    expect(term.loadAddon.mock.calls[0][0]).toBe(mockAddon);
  });

  it('leaves the terminal on the DOM renderer when the addon cannot start', () => {
    addonCtor = () => {
      throw new Error('WebGL2 is not supported');
    };
    const term = { loadAddon: vi.fn() };
    expect(() => loadGpuRenderer(term as never)).not.toThrow();
    /* xterm's own renderer, installed at open(), is still the one in place */
    expect(term.loadAddon).not.toHaveBeenCalled();
  });

  it('falls back to the DOM renderer when the GPU context is lost', () => {
    const term = { loadAddon: vi.fn() };
    loadGpuRenderer(term as never);
    expect(typeof contextLossHandler).toBe('function');
    contextLossHandler?.();
    /* disposing the addon restores xterm's renderer, so the pane keeps
       painting instead of going blank */
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it('survives a context loss after the addon was already disposed', () => {
    const term = { loadAddon: vi.fn() };
    loadGpuRenderer(term as never);
    disposeSpy.mockImplementationOnce(() => {
      throw new Error('already disposed');
    });
    expect(() => contextLossHandler?.()).not.toThrow();
  });

  /* #6068: dispose() does not release the WebGL2 context. The browser caps
     the live contexts per document and evicts the oldest one past the cap,
     which takes down a pane that is still on screen. */
  it('releases the WebGL2 context when the addon is disposed', () => {
    const gl = fakeGl();
    mockAddon._renderer = { _gl: gl };

    const term = { loadAddon: vi.fn() };
    loadGpuRenderer(term as never);
    disposeSpy.mockClear();

    /* the wrapper the loader put on the addon */
    mockAddon.dispose();

    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(gl.getExtension).toHaveBeenCalledWith('WEBGL_lose_context');
    expect(gl.loseContext).toHaveBeenCalledTimes(1);
  });

  it('releases the WebGL2 context even when the addon teardown throws', () => {
    const gl = fakeGl();
    mockAddon._renderer = { _gl: gl };

    const term = { loadAddon: vi.fn() };
    loadGpuRenderer(term as never);

    disposeSpy.mockImplementationOnce(() => {
      throw new Error('teardown failed');
    });

    expect(() => mockAddon.dispose()).toThrow('teardown failed');
    /* the context still has to go, that is the point of the wrapper */
    expect(gl.loseContext).toHaveBeenCalledTimes(1);
  });

  it('does not fail when the addon exposes no context to release', () => {
    const term = { loadAddon: vi.fn() };
    loadGpuRenderer(term as never);

    /* an addon build without the private fields we reach for must not turn
       into a crash: the worst case is the old leak coming back */
    expect(() => mockAddon.dispose()).not.toThrow();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });
});
