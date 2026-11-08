# Lifecycle 1 validation record

Validated on 2026-11-08 against the **0.9.0 unreleased source candidate**,
based on repository commit `04ecdb677735d84f3a0f5dba01a9d9b28c324c0e`.
This records local Linux validation with Node 24.22.1 and npm 12.2.1. It does
not claim a registry release, a macOS run, or a live Codex account acceptance.

## Commands and results

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed against the source API, its public types and all tests. |
| `node --test --test-reporter=tap "tests/*.spec.ts"` | 196 tests: 190 passed, 0 failed, 6 skipped. |
| `npm run test:package` | Built TypeScript, packed the actual package, installed it in a clean consumer, and exercised the exported machine API and installed CLI. Passed. |

The six full-suite skips are existing environment-dependent probes: five
opt-in live Codex tests and one native CLI-presence check (`codex` was not on
PATH). All 13 new lifecycle/recovery tests ran and passed. No live inference
request was made for this validation.

## What was exercised

The lifecycle tests use real subprocesses and an app-server protocol fixture.
The fixture records native `turn/start` requests, allowing the tests to check
the dispatch boundary directly rather than infer it from progress text.

- All six normal events have stable invocation identity, consecutive sequence
  numbers and matching configuration. Each pre-dispatch callback can read its
  already-durable journal while observing zero native turn requests.
- Rejecting `thread-ready`, `dispatch-intent` or `dispatch-possible` prevents
  submission and still obtains physical cleanup evidence. Rejection after the
  possible-send checkpoint remains typed `possible`.
- A missing explicit `thread.ephemeral` boolean fails readiness before any
  turn request; absent evidence is not treated as `false`.
- The full original receipt is readable before terminal notification. A
  rejected terminal callback does not change a completed native result or
  manufacture cancellation.
- Recovery returns the same original receipt, does not change journal mtime,
  and does not add another native request. Missing, corrupt, mismatched and
  symlinked journals fail closed. Reusing a journal refuses a new run.
- Killing the entire caller process group at readiness, acceptance, terminal
  delivery and cleanup delivery leaves the independent supervisor to collect
  original native settlement and group cleanup. No replay is performed.
- Killing the machine supervisor itself during an accepted turn leaves the
  durable journal `pending`, even after the native guardian independently
  stops its process group. Process absence is not promoted to a terminal
  business result.

The installed-package check imports only
`dsh-subagent-codex-pro/machine`, sees lifecycle version 1 and all six events,
and recovers the exact receipt from the compiled supervisor. It also checks
the legacy installed CLI contract and the compiled native guardian. The
package retains a single-result CLI; the new checkpoint channel is JavaScript
API functionality, not an undocumented CLI protocol change.

## Limits of this evidence

The fixtures establish local protocol, persistence and process ownership
behavior. They do not establish account authentication, native-version
compatibility beyond the existing fixtures, server-side history availability,
provider deduplication, billing totals, cache reuse, answer quality or desktop
host behavior. A package capability declaration is not a live acceptance
report. The journal cannot reconstruct unknown execution after simultaneous
supervisor loss or promise exactly-once execution; see the
[lifecycle contract](machine-lifecycle.md) for the recovery boundary.
