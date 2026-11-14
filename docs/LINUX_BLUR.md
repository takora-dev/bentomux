# Linux desktop blur

Bentomux's dark-mode **Translucency → Glass** uses a transparent native window
and the same glass tint as Windows. Text, terminal and content backgrounds
stay solid; light mode and accessibility solid-background preferences are unchanged.

Actual desktop blur must be supplied by the Linux compositor. CSS
`backdrop-filter` can blur web content, but cannot blur other desktop windows
behind the application's native window. Without compositor blur, the desktop
will show through sharply; the tint and highlights still apply.

## GNOME (Ubuntu / Wayland)

1. Install a compatible version of [Blur my Shell](https://extensions.gnome.org/extension/3193/blur-my-shell/).
2. Open its preferences and enable **Applications** blur.
3. Use its application rule/list controls to include the Bentomux window. Prefer
   a per-application rule rather than enabling blur for every application.
4. In Bentomux, select dark mode and enable **Translucency → Glass**.
5. Tune the compositor's blur strength to taste. Bentomux's CSS blur value does
   not control the compositor's desktop blur radius.

Extension support and settings vary with GNOME/extension versions. Bentomux
does not install extensions or alter desktop settings automatically. Avoid
whole-window opacity rules: those also fade text and terminal content.

On other Linux desktops, use the compositor's supported per-window blur rules.
A transparent window alone does not guarantee desktop blur.
