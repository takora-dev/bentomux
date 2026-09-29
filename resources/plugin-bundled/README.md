# Bundled plugins

Plugins that ship with the app live here, one folder per plugin, each with a
`plugin.json` under the reserved `bentomux.` publisher. `sync_bundled` installs
or refreshes every folder it finds on boot, and retires any bundled plugin the
app no longer ships.

This file exists so the directory survives packaging even with no bundled
plugins installed: the retire step only runs when the app can resolve this
folder.
