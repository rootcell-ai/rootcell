# Rootcell Select Command Plan

## Goal

Add `rootcell select <instance>` to persist the current default rootcell
instance. Commands that currently default to `default` should instead default to
the selected instance, while explicit `--instance <name>` continues to override
the selection for one invocation.

This plan also changes guest command pass-through so guest commands must be
written after `--`.

## Selected Behavior

- `rootcell select <instance>` validates `<instance>` with the same rules as
  `--instance`, then persists it as the default instance.
- `rootcell select default` resets the default target back to `default`.
- `rootcell select <instance>` does not require the instance to already exist.
- `rootcell select <instance>` does not seed instance files, load instance
  `.env`, start VMs, provision, or perform provider checks.
- On success, print this to stdout:

  ```text
  selected rootcell instance 'jmp'
  ```

- `rootcell select` with no argument is a usage error with status `2`.
- `rootcell select <instance> extra` is a usage error with status `2`.
- `rootcell select <instance> --init-env <provider>` is a usage error.
- `rootcell select <instance> --instance <other>` is a usage error because
  `--instance` is meaningless for `select`.

## Selection Storage

- Store the selected default under the active rootcell state root:

  ```text
  ${ROOTCELL_STATE_DIR:-<repo>/instances}/.selected-instance
  ```

- The file is plain UTF-8 text containing one instance name plus a newline:

  ```text
  jmp
  ```

- Ensure the state root exists with mode `0700`.
- Write `.selected-instance` with mode `0600`.
- Missing `.selected-instance` means the selected default is `default`.
- Do not create `.selected-instance` for read-only commands or ordinary
  fallback-to-default behavior.
- Present but invalid `.selected-instance` is corrupted CLI state:
  - Empty content is invalid.
  - Multiple non-empty lines are invalid.
  - Embedded whitespace is invalid.
  - Invalid instance names are invalid.
- Invalid `.selected-instance` should fail with status `2` and a clear message:

  ```text
  invalid selected rootcell instance in <path>: <reason>
  ```

- Explicit `--instance <name>` bypasses reading `.selected-instance`, so users
  can still run commands against a known instance if the selection file is bad.

## Selection Precedence

Use this precedence everywhere an instance-scoped command needs a default:

1. Explicit `--instance <name>`
2. `.selected-instance`
3. Built-in fallback `default`

Do not add an environment variable override.

## Commands Affected

The selected default applies to every instance-scoped command when `--instance`
is omitted:

- `rootcell`
- `rootcell edit <target>`
- `rootcell provision`
- `rootcell allow`
- `rootcell pubkey`
- `rootcell spy`
- `rootcell stop`
- `rootcell remove`
- `rootcell extension ...`
- `rootcell --init-env <provider>`

Plain `rootcell list` remains broad and lists all known VM-backed instances.
`rootcell list --instance <name>` remains narrowed to that one instance.

`rootcell remove` must not clear `.selected-instance`; remove deletes provider
VM state or cloud resources while preserving instance-local configuration.

## Guest Command Pass-Through

Stop allowing implicit guest commands.

Valid:

```bash
rootcell
rootcell -- pi
rootcell -- nix flake update
rootcell --instance dev -- pi
```

Invalid:

```bash
rootcell pi
rootcell nix flake update
rootcell --instance dev pi
```

Unknown top-level commands should fail with status `2` and guidance:

```text
unknown rootcell command 'pi' (use 'rootcell -- pi' to run a guest command)
```

If `--instance` is used with a guest command, preserve the same guidance with
the selected instance syntax:

```text
unknown rootcell command 'pi' (use 'rootcell --instance dev -- pi' to run a guest command)
```

`rootcell` with no args still opens the selected instance's interactive shell.

## List Output

`rootcell list` should show the current default target.

Current columns remain:

```text
INSTANCE  VM  STATE
```

Append `(selected)` to the `INSTANCE` cell for every VM row that belongs to the
selected instance:

```text
INSTANCE        VM            STATE
default         agent         running
default         firewall      running
jmp (selected)  agent-jmp     stopped
jmp (selected)  firewall-jmp  stopped
```

If the selected instance has no VM-backed state and would otherwise be absent
from plain `rootcell list`, include missing rows:

```text
jmp (selected)  agent-jmp     missing
jmp (selected)  firewall-jmp  missing
```

This also covers cases where instance files still exist but provider VM state
was deleted outside rootcell, such as with `limactl`.

`rootcell list --instance <name>` should still mark `(selected)` if `<name>` is
the selected default. If another instance is selected, the narrowed rows are not
marked.

### List Styling

- When stdout is a TTY and `NO_COLOR` is not set, render selected rows bold and
  green.
- When stdout is not a TTY, or `NO_COLOR` is set, emit no ANSI escapes.
- Always include `(selected)` regardless of styling.
- Do not add a terminal styling dependency for this change. Use a tiny local
  helper for ANSI formatting.

## Parser Changes

- Add `select <instance>` as a real top-level rootcell subcommand.
- Treat `select` as a reserved rootcell command. Running a guest command named
  `select` requires `rootcell -- select ...`.
- Remove the parser's implicit guest command behavior.
- Keep global `--instance` accepted before or after known rootcell subcommands
  where it works today, except for `select`, where it is invalid.
- Keep global `--instance` accepted before `--` for explicit guest commands.
- Anything after `--` belongs to the guest command and is not parsed as
  rootcell flags.

## Completion Changes

- `rootcell select <TAB>` completes known instance names from the active state
  root.
- `--instance <TAB>` completion remains unchanged.
- Context-sensitive completions, especially `rootcell extension ...`, use the
  selected default when `--instance` is omitted.
- If `.selected-instance` is invalid, completions should fail quietly or return
  no context-sensitive results rather than seeding or repairing state.

## Documentation Changes

Update `--help` examples:

- Show `rootcell select dev`.
- Show guest commands with explicit `--`, for example `rootcell -- pi`.
- Update `--instance` wording to say it overrides the selected default.
- Remove or update examples that imply implicit pass-through still works.

Update README examples and docs:

- Daily Workflow
- VM Lifecycle and instance wording
- Configuration examples that default to `default`
- Troubleshooting snippets that hard-code `default`, either by explaining that
  they are explicit default-instance examples or by using selected-instance
  wording where appropriate

## Implementation Outline

1. Add selected-instance helpers in `src/rootcell/instance.ts`:
   - selected file path resolution
   - read selected default with fallback
   - write selected default
   - validation and parse errors
2. Add `select` metadata in `src/rootcell/metadata.ts`.
3. Update `src/rootcell/args.ts`:
   - add `select <instance>`
   - remove implicit pass-through for unknown commands
   - keep no-arg shell behavior
   - apply selected-default resolution outside the parser or pass the selected
     default into parsing so tests can cover it deterministically
4. Update `src/rootcell/rootcell.ts`:
   - dispatch `select`
   - resolve selected default for instance-scoped commands
   - keep `--instance` override behavior
   - keep plain `list` broad while marking selected rows
5. Update `formatVmList` to support selected-instance marking and optional ANSI
   styling.
6. Update shell completions for `select` and selected default context.
7. Update README and help examples.
8. Add tests.

## Test Plan

Add focused unit tests for:

- Missing `.selected-instance` falls back to `default`.
- `rootcell select jmp` writes `.selected-instance` with `jmp\n`.
- `rootcell select default` resets by writing `default\n`.
- `select` rejects missing, invalid, extra, `--init-env`, and `--instance`
  combinations.
- `--instance` overrides selection and does not modify `.selected-instance`.
- Invalid `.selected-instance` fails when no explicit `--instance` is present.
- Explicit `--instance` still works when `.selected-instance` is invalid.
- `rootcell edit env` uses the selected default when `--instance` is omitted.
- `rootcell --init-env <provider>` uses the selected default when `--instance`
  is omitted.
- Plain `rootcell list` remains broad and marks selected rows.
- Plain `rootcell list` includes selected missing rows when no VM-backed state
  exists for the selected instance.
- `rootcell list --instance <name>` marks rows only when `<name>` is selected.
- `formatVmList` emits plain `(selected)` output without ANSI escapes.
- `formatVmList` emits bold green selected rows when color is enabled.
- `formatVmList` emits no ANSI escapes when color is disabled or `NO_COLOR` is
  set.
- `rootcell pi` fails with guidance to use `rootcell -- pi`.
- `rootcell -- pi` remains valid guest command pass-through.
- `rootcell --instance dev -- pi` targets `dev`.
- `rootcell select <TAB>` completes known instance names.
- Extension completions use the selected default when `--instance` is omitted.

Run at least:

```bash
bun run typecheck
bun run lint
bun run test:unit:vitest
git diff --check
```
