# Bentomux Plugin Marketplace

How to get a plugin into the marketplace. For how plugins *work* — the
manifest, permissions, contribution points, the Plugin Context — read
[`PLUGIN_PLATFORM.md`](./PLUGIN_PLATFORM.md). This document is only about
distribution.

## The short version

Push a GitHub repo. Tag it with the topic `bentomux-plugin`. Publish a release
with a `.zip` asset. It shows up in the marketplace.

```
bentomux
  └─ Plugin Studio
       └─ Browse marketplace…
            └─ owner/your-plugin  ★ 314   ↓ 1.2k
```

No server. No database. No submission form. No moderation queue. GitHub *is*
the catalog.

## Why GitHub and not our own registry

A registry needs a server, a database, an account system, an upload path, a
moderation queue, a takedown process, and a bill. GitHub already has all of
it, plus the thing a marketplace actually needs: a place authors already
publish, and an audience that already stars repos.

The cost is the rate limit, and the limit is real:

| Bucket | Limit | Source |
|---|---|---|
| Core REST (per IP, unauthenticated) | **60 requests / hour** | `x-ratelimit-limit: 60` on `GET /rate_limit` |
| Search REST (per IP, unauthenticated) | **10 requests / minute** | `resources.search.limit: 10` on `GET /rate_limit` |

The numbers above were read from the live API, not from documentation.

So the marketplace spends **one search plus one release call per plugin** and
caches the result for six hours. One sweep of 30 plugins costs 31 of the 60
hourly requests, and stars come free from the search response rather than
costing a call each.

## Publishing

### 1. The repo

A folder holding `plugin.json` and an ES module entry. From a template:

```bash
cp -r resources/plugin-templates/basic ~/acme-habit-tracker
```

Edit `plugin.json`: `id` is `publisher.name` with both segments matching
`[a-z0-9-]+`. Pick a publisher you control — `bentomux` is reserved for
plugins bundled in the app.

### 2. The topic

Add `bentomux-plugin` to the repo's topics. That is the entire registration
step; there is nothing to submit and nobody to approve.

```bash
gh repo edit --add-topic bentomux-plugin
```

Confirm it works:

```bash
gh api -H "Accept: application/vnd.github+json" \
  "/search/repositories?q=topic:bentomux-plugin" \
  --jq '.total_count, (.items[] | .full_name)'
```

### 3. Validate

```bash
bentomux --plugin-validate ~/acme-habit-tracker --json
```

Exit `0` is ok, `1` means errors were found, `2` is a usage error. Fix every
error before you publish.

### 4. Zip it

```bash
cd ~/acme-habit-tracker
zip -r ../acme-habit-tracker-1.0.0.zip . -x '*.DS_Store' '__MACOSX/*' '.git/*'
```

**The plugin files must sit at the root of the zip.** `plugin.json`,
`index.js`, and any assets go in directly — *not* inside a wrapper directory.
A repo archive downloaded by GitHub puts the repo in a wrapper directory, which
is why the release asset must be a zip you build, not the auto-generated source
tarball.

### 5. Publish the release

```bash
gh release create v1.0.0 ../acme-habit-tracker-1.0.0.zip \
  --title "Acme Habit Tracker 1.0.0" \
  --notes "First release."
```

Exactly one `.zip` asset per release. Zero is not installable; two is ambiguous
and the marketplace refuses rather than guessing.

**You do not compute a digest.** GitHub computes the sha256 of every release
asset when it is uploaded, publishes it as the asset's `digest` field, and the
marketplace reads it from the API and enforces it on download. This is why a
release is required: the repo tarball that GitHub generates for a tag has no
published checksum, so there is nothing to verify it against.

### 7. Tag the release as `vX.Y.Z`

Tag format is not cosmetic — it is how updates are detected.

The marketplace compares the **release tag** against the **installed manifest
version** to decide whether to offer an update. It strips a single leading `v`
and parses the rest as semver, so `v1.2.0` and `1.2.0` both work and anything
else — `release-3`, `2026-01-15`, `nightly` — is not a version and gets no
update offered. That is deliberate: a tag the app cannot order is a tag it must
not claim an upgrade from.

So **the tag and the manifest `version` must agree.** `v1.2.0` in the tag,
`1.2.0` in `plugin.json`. A repo tagged `v1.1.0` whose manifest still says
`1.0.0` will keep offering the same update forever.

### 8. Wait, or hit Refresh

The catalog is cached for six hours. **Browse marketplace… → Refresh** re-sweeps
immediately. The button greys out while it runs: one forced sweep costs one
search plus one release call per repo — up to 31 of GitHub's 60 unauthenticated
requests an hour — so a double-click would spend half the budget and leave the
marketplace stale for the next six hours.

## Browsing: order, search, pages

**Most-starred first.** The sweep sorts before it returns, so the list is
ordered most-starred-first whether it comes from the network or from cache.
Equal stars are broken by repo name. That tie-break is not cosmetic once the
list paginates: two tied plugins swapping places between refreshes would put
the same plugin on two different pages at once.

**Search** matches the display name, the description, and the owner/repo, and
is case-insensitive. It runs over the list already in memory rather than
re-querying GitHub — a search request per keystroke would spend the 10-per-
minute search rate limit on a text box.

**Ten rows a page**, with Previous/Next and a `Page N of M` readout. The pager
appears only past one page. A search that matches nothing shows the query and
a Clear button; a result set that shrinks under the current page clamps back
into range instead of showing a blank screen.

The paging and filtering rules live in `src/shared/marketplace.ts` and are
covered by `src/shared/marketplace.test.ts` — the clamping and boundary cases
are easy to get wrong and cheap to pin down there.

## Updating

The catalog is re-read every time the marketplace is opened, and each row is
joined against the app's own installs, so a row shows one of:

| Row says | Meaning |
|---|---|
| **Install** | Not installed |
| **Update to vX.Y.Z** | The release tag is strictly newer than what is installed |
| **Reinstall** | Installed, and the release is not newer |

An update re-runs the same review screen as a first install — **new code can
ask for permissions the old code did not**, and the user sees that before it
runs, not after.

Behind the button, in order:

1. The digest is **re-verified** against the downloaded bytes. The renderer
   checked it once already, but the decision spans two IPC calls, so the bytes
   are hashed again rather than trusted from a path.
2. The manifest is read **out of the archive**, not out of the catalog. A repo
   cannot claim a version it does not ship, and cannot swap in a different
   plugin id.
3. The version must be **strictly newer**, checked against the installed
   manifest version. An equal or older version is refused, because committing
   it would set the rollback target to the version already on disk.

Then the old version directory is kept as the rollback target and the new one
becomes current. **Roll back** appears in Settings → Plugins. Exactly one
previous version is kept: a third release garbage-collects the oldest.

Only plugins installed **from the marketplace** are matched. One installed by
hand from a folder or a zip has no recorded repo, so it is invisible to the
join and is never offered an update. Reinstall it from the marketplace to
start tracking it.

## What a reader sees, and where each number comes from

| Shown | Source | Honest label |
|---|---|---|
| ★ stars | `stargazers_count` from the topic search | GitHub stars for the repo |
| ↓ downloads | `download_count` on the release asset | Downloads of that asset — including non-Bentomux ones, if any |
| version | `tag_name` of the latest release | The release tag |
| description | the repo's GitHub description | The repo's, not the manifest's |
| sha256 | the asset's `digest` | Verified before install |

**None of these come from the plugin.** The real `plugin.json` — its id, name,
permissions, contribution points, network hosts — is read from inside the
downloaded archive during install, and the review screen shows it before
anything runs. A repo can lie about its description or its name and gain
nothing.

The README shown in **Details & README** is fetched from
`raw.githubusercontent.com/<owner>/<name>/<tag>/README.md`, at the release tag
so it matches the version being offered, and displayed as plain text. It is not
rendered to HTML: the renderer reserves `innerHTML` for compile-time constants
and forbids file content, so rendering a third-party README would mean writing
an HTML sanitizer to make it safe. Plain text is the entire fix.

## The security story, stated plainly

```
GitHub serves the bytes. The sha256 decides if they are accepted.
```

GitHub publishes each asset's digest at upload and the app checks the download
against it. A tampered or substituted asset fails the digest check and never
reaches the installer. This is the same guarantee the manual install-from-URL
flow has always had — the catalog just fills in the digest for the user instead
of asking them to paste it.

What it is **not**:

- **Not a sandbox.** Plugins run in the app's realm and permissions are a
  contract, not a wall (`adr/0001`). Read it before publishing anything that
  requests `agents.write` or `backend.invoke`.
- **Not a code review.** Nothing here vets your code. The Validator
  (`bentomux --plugin-validate`) checks structure, not behaviour.
- **Not a reputation signal.** Stars and download counts are GitHub's numbers,
  surfaced as-is. They are not an endorsement by Bentomux.

## Troubleshooting

**My repo does not appear.** Topics take a few minutes to index after you set
them. Confirm with the `gh api` check in step 2 — if GitHub finds it and
Bentomux does not, it is the six-hour cache; hit **Refresh**.

**"No published release yet."** No GitHub release on the repo, or the latest
release has no `.zip` asset. Both mean the same fix: `gh release create` with a
zip.

**"This asset predates GitHub's release digests."** The asset was uploaded
before GitHub published checksums, so it cannot be verified. Re-upload it as a
new release.

**"Release X has 2 .zip assets."** Ambiguous. Ship exactly one.

**"showing saved copy".** The refresh hit GitHub's rate limit or the network
failed. The catalog is served from disk rather than shown empty, and the reason
is in the banner. It resolves on its own within the hour; **Refresh** is safe to
try again.

**Digest mismatch.** The bytes changed after GitHub published the digest, which
should not happen. Do not retry — report it.

**"already installed; this release is X, which is not newer".** The tag and the
manifest version disagree, or the release is older than what is installed. Check
that the tag matches `plugin.json`.

**"this release is X but the installed plugin is Y".** The archive contains a
different plugin id than the one installed from this repo. Somebody swapped the
archive, or the release is wrong.

**"Y is not installed from this repository".** It was installed by hand, so the
app has no repo to match. Reinstall it from the marketplace once.

## Related

- [`PLUGIN_PLATFORM.md`](./PLUGIN_PLATFORM.md) — the platform spec: manifest,
  permissions, contribution points, validation.
- [`adr/0001-in-realm-plugin-execution.md`](./adr/0001-in-realm-plugin-execution.md)
  — why permissions are a contract, not a sandbox.
- [`adr/0004-frontend-only-plugins.md`](./adr/0004-frontend-only-plugins.md) —
  plugins cannot add backend commands.