# Validation reference

Generated from `src-tauri/src/plugin/validate.rs` — do not edit by hand.

Validate with:

    bentomux --plugin-validate <folder>          # human-readable
    bentomux --plugin-validate <folder> --json   # machine-readable

Exit codes: `0` valid, `1` errors found, `2` usage error.

**One run reports every problem it can find**, not just the first — so fix all
of them and run once more rather than iterating one error at a time.

## Issue codes

| Code | Meaning |
|---|---|
| `manifest-missing` | manifest missing |
| `manifest-unreadable` | manifest unreadable |
| `manifest-invalid` | manifest invalid |
| `id-shape` | id shape |
| `id-reserved` | id reserved |
| `version-invalid` | version invalid |
| `api-version-unknown` | api version unknown |
| `min-app-version-invalid` | min app version invalid |
| `entry-missing` | entry missing |
| `entry-escapes-root` | entry escapes root |
| `entry-empty` | entry empty |
| `entry-not-module` | entry not module |
| `contribution-id-shape` | contribution id shape |
| `contribution-id-duplicate` | contribution id duplicate |
| `permission-unknown` | permission unknown |
| `network-invalid` | network invalid |
| `permission-unused` | permission unused |
| `command-undeclared` | command undeclared |
| `icon-unknown` | icon unknown |
| `icon-missing` | icon missing |
| `size-exceeded` | size exceeded |
| `no-contributions` | no contributions |

## Limits

- Total plugin size: 5 MB (5 * 1024 * 1024 bytes), symlinks pointing outside the
  folder are refused.
- `apiVersion` must match the host's, currently 1. A mismatch is refused
  outright, not warned about.
- `minAppVersion` is advisory: a mismatch warns, it does not refuse.

## What is not checked statically

JavaScript syntax. The CLI path shells out to `node --check`; the in-app
validator does not, and a syntax error surfaces as a failed activation instead.
Run the CLI before installing.
