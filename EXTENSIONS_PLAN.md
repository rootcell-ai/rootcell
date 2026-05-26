# Rootcell Extensions Implementation Plan

Status: Phase 5 documentation and migration notes are implemented; the V1 Rootcell extensions plan is complete.

## Goal

Add an opt-in Rootcell extension mechanism so optional Rootcell capabilities can be installed and activated per instance without shipping every optional integration to every user by default.

Rootcell extensions are not the same thing as Pi extensions. A Rootcell extension may install/configure Pi extensions, add host commands/tunnels, ship firewall services, or eventually target other coding harnesses such as Claude Code or Codex. Pi integration is the first use case, not the abstraction boundary.

The initial two built-in Rootcell extension ids are `pi-plannotator` and
`pi-subagents` because they install/configure Pi resources. The `pi-` prefix is
part of the name, not the extension abstraction.

Initial target extensions:

- Existing Pi `subagent` package/extension currently installed for every agent VM by `home.nix`; should move behind opt-in.
- Plannotator Pi package (`@plannotator/pi-extension` / `apps/pi-extension`) which requires host-browser access to a server running inside the agent VM.
- The existing `spy` feature is a plausible future Rootcell extension, reinforcing that the feature must not be coupled one-to-one to Pi extensions.

## Resolved decisions summary

- Rootcell extensions are per-instance opt-ins, persisted in host-side `instances/<name>/extensions.txt`.
- `extensions.txt` is dotenv-style `id=true|false`, seeded with all known extensions set to `false`.
- Initial UX: `rootcell extension list`, `rootcell extension enable <id>`, `rootcell extension disable <id>`, and `rootcell edit extensions`.
- Extension-specific commands live under `rootcell extension <id> ...`; initial operational command is `rootcell extension pi-plannotator tunnel`.
- `extension enable/disable` seed config files if needed, are idempotent, do not provision, and always print instance-qualified provision guidance.
- Operational extension commands require the selected existing instance to have that extension enabled; completions should hide disabled extension command groups.
- Rootcell extension definitions are static built-ins for V1, but shaped for future third-party extraction.
- Rootcell extensions are harness-agnostic and not 1:1 with Pi extensions.
- Guest contributions are separate NixOS/Home Manager module fragments hooked into agent NixOS, firewall NixOS, and agent Home Manager via generated aggregators.
- Built-in guest/Nix payloads live under top-level `extensions/`; TypeScript registry/host command code lives under `src/rootcell/extensions/`.
- Generated aggregators live in the per-instance generated dir, are copied explicitly into the VM, and use repo-relative imports.
- Extension resources should be installed declaratively via Nix/Home Manager, not by imperative host copies into final guest paths.
- Do not let Home Manager own Pi's user-editable `~/.pi/agent/settings.json`; use Pi auto-discovery/package-compatible filesystem locations.
- Plannotator uses the published npm package if suitable, installed through Nix/Home Manager while preserving source/package inspectability.
- Plannotator sets `PLANNOTATOR_REMOTE=true` and `PLANNOTATOR_PORT=19432` in the enabled Home Manager module.
- Plannotator tunnel goes through firewall ProxyJump to the agent VM, binds host side to `127.0.0.1`, prefers local port `19432`, chooses another free local port on conflict, prints the URL, and stays foreground until Ctrl-C.
- Plannotator tunnel does not start/provision VMs, does not health-check the service, does not open a browser, and is separate from running Pi.
- `pi-subagents` opt-in preserves current behavior: Pi subagent extension plus example agents.
- Existing VMs keep old subagent files until explicit provision; after provisioning with `pi-subagents=false`, managed subagent resources are removed.
- Testing should focus on the Rootcell extension framework, command dispatch, generated config, completions, and tunnel wiring, not Plannotator product behavior.

## Non-goals for V1

- No third-party Rootcell extension loading yet; keep the built-in registry extractable for later.
- No auto-provision or extension drift detection; extension changes require explicit `./rootcell provision`.
- No background tunnel supervision or tunnel daemon management.
- No Rootcell integration tests for actual Plannotator product behavior.
- No Home Manager ownership of Pi's user-editable `~/.pi/agent/settings.json`.

## Observed codebase facts

- The host command is implemented in TypeScript under `src/rootcell/` and exposed by `src/bin/rootcell.ts`.
- Rootcell currently has a flat set of built-in host subcommands in `src/rootcell/metadata.ts` and `src/rootcell/args.ts`.
- Agent provisioning copies a fixed file set (`VM_FILES.agent`) and builds `agent-vm.nix` plus `home.nix` via Home Manager.
- `home.nix` currently unconditionally installs:
  - Pi itself.
  - Rootcell skills under `~/.pi/agent/skills/`.
  - The Pi `subagent` extension under `~/.pi/agent/extensions/subagent`.
  - Example subagent agent definitions under `~/.pi/agent/agents/`.
- The `jmp/plan-browser-spy-replacement` branch adds a reusable-looking host-to-guest local port forward concept (`VmProvider.forwardLocalPort`) for browser UI access.
- Plannotator starts HTTP servers from inside Pi and uses:
  - `PLANNOTATOR_REMOTE` to force remote-session behavior.
  - `PLANNOTATOR_PORT`, defaulting to `19432` for remote sessions.
  - browser URLs of the form `http://localhost:<port>`.
  - `0.0.0.0` binding in remote mode and `127.0.0.1` otherwise.

## Architecture

1. Add a static built-in Rootcell extension registry describing optional features for the first iteration. Design the registry shape as a future public extension-definition API so third-party Rootcell extensions can be supported later without a rewrite. Include human-readable descriptions for help/docs, but default `extension list` only shows id/status. Do not include `defaultEnabled` in the registry; all known extensions are seeded as disabled in `extensions.txt` by policy.
2. Persist enabled extensions per Rootcell instance in a human-editable `extensions.txt` file at `instances/<name>/extensions.txt`, next to that instance's `.env` and `secrets.env` files. Add this path to `instancePaths` as `extensionsPath`. The file is dotenv-like and seeded with every known extension defaulting to false, e.g. `pi-plannotator=false` and `pi-subagents=false`, so users can discover available extensions without the CLI. If missing for an existing instance, seed it the same way and log the path. Comments and blank lines are supported and preserved. Existing ordering is preserved. Missing newly-known extension keys are appended with `false`. Unknown keys are warned about and ignored by the current Rootcell version, but preserved when the CLI rewrites the file for forward/backward compatibility.
3. During provisioning, render generated Nix/config that installs only enabled Rootcell extension resources. Extension-provided guest files should be installed by NixOS/Home Manager modules or Nix derivations wherever possible, not manually copied into final guest locations by the host CLI. Rootcell may still copy the Rootcell repo/generated Nix inputs into the VM so Nix can evaluate them, but ownership of guest-visible extension resources should be declarative through Nix/Home Manager. Model this as hook points in the master guest configs: agent NixOS, firewall NixOS, and agent Home Manager import generated extension module lists. Extensions create/implement separate module files referenced by those masters; extensions must not edit the master config files themselves.
4. Add host command surface to manage extensions under `rootcell extension`. Parse `extension` as a top-level Rootcell subcommand that captures the rest; dispatch nested commands manually through an extension command dispatcher rather than modeling every nested command directly in yargs. This supports dynamic enabled-extension completions now and future custom extension completion behavior. Initial commands:
   - `rootcell extension list` showing all known extensions and enabled/disabled status, plus a warning/list for unknown valid keys found in `extensions.txt`; do not include a `requiresProvision`/apply column in the first iteration
   - `rootcell extension enable <id>`
   - `rootcell extension disable <id>`
   - `rootcell extension pi-plannotator tunnel`
5. Reuse or generalize the SSH local-port forwarding implementation from the spy-browser branch for browser-backed extensions.
6. Implement Plannotator as the first browser-backed extension:
   - install/configure the Plannotator Pi package in the agent VM only when opted in;
   - set remote-friendly environment variables for Pi sessions;
   - provide a host command that opens/maintains a tunnel from host localhost to the agent VM Plannotator server port via the firewall/SSH transport.
7. Move the built-in `subagent` Pi extension and bundled example agents behind the same opt-in mechanism.

## Detailed decision log

### Scope and registry

- Rootcell extensions are harness-agnostic and not one-to-one with Pi extensions. A Rootcell extension can contribute Pi resources, other harness resources, host commands, tunnels, firewall services, or guest modules.
- The first iteration uses a static built-in registry only, but the registry shape should be future-compatible with third-party Rootcell extension definitions.
- Registry metadata should include ids, descriptions, `requiresProvision`, guest hook contributions, and extension host commands. It should not include `defaultEnabled`; all known extensions are seeded disabled by policy.
- Extension ids use lowercase kebab-case suitable for CLI and file keys.
- Registry descriptions are for help/docs; default list output remains id/status only.

### Instance config and UX

- Extensions are enabled/disabled per Rootcell instance, not globally or per invocation.
- Persist state in host-side `instances/<name>/extensions.txt`, exposed as `instancePaths(...).extensionsPath`. Do not copy this file into the VM.
- `extensions.txt` is seeded with all known extensions set to `false`, e.g. `pi-plannotator=false` and `pi-subagents=false`. Missing files for existing instances are seeded the same way and logged.
- Parse `extensions.txt` with Rootcell dotenv-style semantics: skip blank/comment lines, split on the first `=`, and treat missing `=` as an empty value.
- Boolean parsing accepts `true`, `1`, `yes`, `on` as true; `false`, `0`, `no`, `off`, and empty values as false. Invalid key syntax or invalid boolean values fail clearly.
- Comments, blank lines, and existing ordering are preserved. Missing newly-known extension keys are appended with `false`. Unknown valid keys are warned/ignored by this version but preserved on rewrite.
- Legacy first-party keys `plannotator` and `subagent` are migrated to `pi-plannotator` and `pi-subagents` when Rootcell rewrites `extensions.txt`.
- `extension enable`/`disable` reject unknown ids for V1. Unknown valid keys may be preserved if already present, but the CLI should not create them until third-party definitions exist.
- Initial UX: `rootcell extension list`, `rootcell extension enable <id>`, `rootcell extension disable <id>`, and `rootcell edit extensions`.
- `rootcell extension list` seeds config if missing, shows all known extension ids and enabled status, and reports unknown valid keys separately. It should not load provider config or secrets and should not show `requiresProvision`/apply columns.
- `extension enable`/`disable` seed config files if needed, are idempotent, do not provision, and always print instance-qualified provision guidance because prior enable/disable may not have been provisioned yet.
- `rootcell extension` with no nested command is incomplete/invalid and should show help/completion guidance; missing ids/subcommands are parse errors, not prompts.
- Editing extensions while VMs are running is allowed, but changes apply only after explicit `./rootcell provision`.
- The file contains no secrets; normal user-editable permissions (`0644` subject to umask) are fine, preserving existing permissions where practical.

### Command parsing and completion

- Add `extension` as a top-level Rootcell subcommand that captures the rest. Dispatch nested commands manually through an extension command dispatcher rather than modeling all nested commands in yargs.
- Extension-specific host commands live under `rootcell extension <id> <command>` to avoid top-level namespace clutter.
- Extension host commands use a minimal registry interface (`name`, `description`, `complete`, `run`) and a narrow V1 context, not the full `RootcellApp`. Expose only required helpers/data such as config, provider/tunnel helper, logging, enabled-state helpers, and VM-running checks.
- Enabled state gates extension-specific operational command availability. `requiresProvision` controls enable/disable guidance only.
- Dynamic shell completion should inspect current words, including `--instance`/`-i`, read that instance's `extensions.txt`, and offer operational extension ids only when enabled.
- Completion must not write/seed files; if `extensions.txt` is missing, assume all known extensions are disabled.
- `rootcell extension <TAB>` should always include management commands (`list`, `enable`, `disable`) plus enabled extension ids. `enable <TAB>` suggests disabled known ids; `disable <TAB>` suggests enabled known ids.

### Guest configuration hooks

- Provide hook points for agent NixOS, firewall NixOS, and agent Home Manager.
- Master configs (`agent-vm.nix`, `firewall-vm.nix`, `home.nix`) import generated aggregator modules. Each enabled extension contributes separate module fragment file(s); generated aggregators compose them with Nix `imports = [ ... ]`. Extensions never mutate master files or shared aggregators directly.
- Generated aggregators live in the per-instance generated directory, are copied explicitly into the VM as `generated/extensions-agent-vm.nix`, `generated/extensions-firewall-vm.nix`, and `generated/extensions-home-manager.nix`, and use repo-relative imports. Do not copy the whole generated directory.
- Rootcell writes valid empty aggregators before provisioning/evaluation, and master configs guard imports with `builtins.pathExists` for clean checkout/direct evaluation safety.
- Write/update aggregators before any path that may evaluate guest Nix, not only during `provision`.
- Extension guest resources should be installed declaratively via NixOS/Home Manager modules or Nix derivations, not by imperative host copies into final guest paths. Rootcell may still copy repo/generated Nix inputs into the VM for evaluation.
- Do not add new extension-specific `specialArgs` in V1. Extension modules receive existing args (`username` today) and keep constants in their own files unless a future API needs more.
- TypeScript registry/host command code lives under `src/rootcell/extensions/`; built-in guest/Nix payloads live under top-level `extensions/`. Keep path/metadata design extractable so built-ins can later move out-of-repo.
- Copy top-level `extensions/` to both VMs initially. Activation still happens only through generated imports.
- Hook model may represent firewall-only contributions, but do not support firewall-only Rootcell operation; Rootcell remains an agent+firewall system.
- Do not add extension-specific provisioned-state checks or auto-provision behavior in V1. Explicit `./rootcell provision` is required after extension changes. Log enabled extensions concisely during provision.

### Pi integration

- Nix controls pinned package content and Pi loads resources through normal mechanisms.
- Do not let Home Manager own or clobber user-editable `~/.pi/agent/settings.json`. Pi code inspection found only global/project `settings.json` sources and no separate settings fragment/include mechanism.
- Use Pi auto-discovery/package-compatible filesystem locations for Rootcell-managed resources. Pi auto-discovers `~/.pi/agent/extensions`, `skills`, `prompts`, and `themes`; for an extension directory, `package.json` with a `pi` manifest is honored before `index.ts`/`index.js` fallback.
- Home Manager may manage specific Rootcell-owned files/subdirectories under Pi auto-discovery roots while leaving parent directories user-writable.
- Leave exact Plannotator package-compatible filesystem layout to implementation, constrained by: do not own `settings.json`, preserve Pi loading semantics, and keep package/source files inspectable.

### Plannotator

- Prefer the published npm package `@plannotator/pi-extension`, pinned by version/hash, if it contains source-like extension files and built browser assets needed at runtime.
- Install/configure via Nix/Home Manager during VM provisioning, following the existing Pi/subagent pattern. Do not use mutable in-VM `pi install` or host-side prefetch/copy cache.
- Preserve a source-like npm package layout in the VM so Pi and the agent can inspect JS/TS code; do not rename/reshape it just because the Rootcell extension id is `pi-plannotator`.
- Set `PLANNOTATOR_REMOTE=true` and `PLANNOTATOR_PORT=19432` in the enabled Plannotator Home Manager module/user environment so any Pi invocation sees them.
- Keep Plannotator tunnel and Pi execution separate. Users run `rootcell extension pi-plannotator tunnel` in one terminal and start Pi normally in another.
- `rootcell extension pi-plannotator tunnel` requires the selected existing instance to have Plannotator enabled and the agent VM running. It does not seed, start, provision, or health-check.
- The tunnel goes through the firewall via SSH ProxyJump to the agent VM, forwarding to agent-side port `19432`. Bind host side to `127.0.0.1` only.
- Prefer host local port `19432`; if busy, choose another free localhost port and print the actual URL.
- Foreground until Ctrl-C only. Do not add background mode, browser auto-open, or `--open` in V1. Print a concise forwarding/Ctrl-C message and the host URL.
- Tunnel metadata should support both agent and firewall target roles for future extensions. Reuse the generic `VmProvider.forwardLocalPort` / SSH tunnel implementation from the spy browser branch once merged.

### Subagent migration

- Move current unconditional subagent install into the `pi-subagents` Rootcell extension's Home Manager hook.
- Enabling `pi-subagents` preserves current behavior: install the Pi subagent extension plus bundled example agents (`planner.md`, `reviewer.md`, `scout.md`, `worker.md`).
- All extensions default false. Existing VMs keep current files until explicit provision; after provisioning with `pi-subagents=false`, managed subagent resources are removed. Document how to opt back in.

### Testing

- Test the Rootcell extension framework: config parsing/rewrites, boolean handling, comment/unknown-key preservation, generated Nix aggregators, command dispatch, explicit-provision workflow, dynamic completions across instances, and tunnel setup behavior.
- Do not add Rootcell integration tests for actual Plannotator product usage. Plannotator-specific behavior belongs in the extension's own repository when it is moved out.

## Recommended implementation file/module breakdown

- `src/rootcell/extensions/registry.ts` — static built-in registry, future-shaped for third-party definitions.
- `src/rootcell/extensions/config.ts` — `extensions.txt` seeding, parsing, preserving, enable/disable rewrites, enabled-state queries.
- `src/rootcell/extensions/commands.ts` — `rootcell extension ...` nested command dispatcher and completion helpers.
- `src/rootcell/extensions/nix.ts` — generated Nix aggregator rendering for agent NixOS, firewall NixOS, and agent Home Manager hooks.
- `extensions/pi-subagents/home-manager.nix` — Home Manager hook module preserving current subagent behavior behind opt-in.
- `extensions/pi-plannotator/home-manager.nix` — Home Manager hook module for Plannotator package/env setup.
- `agent-vm.nix`, `firewall-vm.nix`, `home.nix` — master configs gain stable guarded imports of generated hook aggregators only.
- `src/rootcell/instance.ts` / types — add `extensionsPath`.
- `src/rootcell/args.ts` / metadata — add top-level `extension` command capture and completion routing.
- `src/rootcell/rootcell.ts` — call extension config generation/copy helpers and dispatch extension commands without hard-coding individual extension behavior.

## Risks / implementation unknowns

- Exact Nix packaging method for `@plannotator/pi-extension` while preserving a source-like npm package layout and including its runtime dependencies/assets.
- Exact Pi auto-discovery/package-compatible filesystem layout for Plannotator under Rootcell-managed paths; implementation should validate against Pi's resource loader behavior.
- Home Manager migration behavior when moving current subagent symlinks out of unconditional `home.nix` and behind the `pi-subagents` extension.
- Availability/API shape of the generic `forwardLocalPort` implementation from the spy browser branch at implementation time.
- Future third-party Rootcell extension extraction: keep built-in registry/path assumptions contained so external extension definitions can be loaded later.

## Implementation phases

### Phase 1: Core extension model

Implementation update: the first Phase 1 slice added a Zod-validated built-in extension registry, per-instance `extensions.txt`, management CLI commands, dynamic completions, generated Nix hook aggregators, guarded master imports, explicit generated-file VM copy wiring, and moved the Pi `subagent` extension/example agents behind `pi-subagents=true`. Verification passed with `bun run typecheck`, `bun run lint`, `bun run test:unit:vitest`, and lightweight Nix evals for the agent, firewall, and Home Manager entrypoints.

Implementation update: the host-command registry slice added `RootcellExtensionDefinition.hostCommands`, validated command metadata, async extension-owned command dispatch under `rootcell extension <id> <command>`, metadata-driven enable/disable guidance through `requiresProvision`, enabled-state gating for operational commands, dynamic completions for enabled command groups, and a narrow `ExtensionHostCommandContext` exposing only config, logging, VM status, and local-port-forward helpers. The slice intentionally did not add `pi-plannotator tunnel`; that remains a later tunnel/Plannotator task. Verification passed with `bun run typecheck`, `bun run lint`, `bun run test:unit:vitest`, and `git diff --check`.

- [X] Define extension ids and metadata in TypeScript.
- [X] Do not model per-extension defaults in the registry; seed all known extension keys as `false` in `extensions.txt`.
- [X] Include `requiresProvision` in extension metadata so the CLI can print accurate next steps.
- [X] Include a minimal extension host command registry interface even in the first implementation: an extension can define commands with `name`, `description`, `complete`, and `run`.
- [X] Pass extension host commands a narrow V1 context rather than the entire `RootcellApp`: include only what is needed, such as config, providers/tunnel helper, logging, enabled-state helpers, and VM-running checks.
- [X] Model guest-side extension contributions as declarative hook modules for each master config: `agent-vm.nix`, `firewall-vm.nix`, and `home.nix`.
- [X] Store first-party built-in guest/Nix payload files under a top-level `extensions/` directory, e.g. `extensions/pi-subagents/home-manager.nix` and `extensions/pi-plannotator/home-manager.nix`.
- [X] Store TypeScript registry/host command implementation under `src/rootcell/extensions/`.
- [X] Treat these built-in locations as the current first-party source layout, not as a permanent coupling: design paths/metadata so these built-ins can later move out of the repository when third-party Rootcell extensions are supported.
- [X] Copy the top-level `extensions/` directory to both VMs with the Rootcell repo inputs in the first implementation. Nix only imports enabled fragments through generated aggregators; selective copying can come later if needed.
- [X] Add stable hook imports in the master files, e.g. generated aggregator modules under `generated/extensions-*.nix`.
- [X] Write generated aggregator files to the existing per-instance generated directory (`instances/<name>/generated/`) and copy them into the VM as part of the generated inputs; do not write per-instance generated files into the Git working tree.
- [X] Copy only the expected generated hook files explicitly (`extensions-agent-vm.nix`, `extensions-firewall-vm.nix`, `extensions-home-manager.nix`) rather than copying the entire generated directory, to avoid stale/extra artifacts.
- [X] Rootcell should always write valid empty aggregators before provisioning/evaluation, and master configs should also guard imports with `builtins.pathExists` so direct evaluation/tests on a clean checkout do not fail.
- [X] Generated aggregators should use repo-relative import paths, not absolute host paths, because the repo is copied into and evaluated inside the VM.
- [X] Each extension owns its own NixOS/Home Manager module fragment file(s). Multiple extensions compose because the generated aggregator contains an `imports = [ ... ]` list of enabled extension module paths; extensions never modify the aggregator themselves and never modify master config files.
- [X] Extensions provide separate NixOS/Home Manager module files or Nix package paths referenced by those hooks; extensions do not directly modify master config files.
- [X] Do not add new extension-specific `specialArgs` in the first iteration. Extension modules receive the same args as existing NixOS/Home Manager modules (`username` today) and should keep constants in their own module/sibling Nix files.
- [X] Avoid host-side imperative copying into final guest paths for extension resources.
- [X] Add parsing/storage for enabled extension ids.
- [X] Add generated Nix file(s) consumed by the master hook imports to conditionally include enabled extension modules.
- [X] Write/update generated extension aggregators before any command path that may evaluate guest Nix (provision and normal ensure paths), even though extension changes still require explicit provision to take effect.
- [X] During `provision`, log the enabled extension set concisely (including `none`).
- [X] Change `home.nix` so the Pi subagent package is no longer unconditional and is provided by the `pi-subagents` Home Manager hook module.
- [X] The `pi-subagents` Rootcell extension should preserve current behavior behind opt-in: install the Pi subagent extension and the bundled example agents (`planner.md`, `reviewer.md`, `scout.md`, `worker.md`).
- [X] Add tests around the Rootcell extension framework itself: parsing, boolean handling, comment preservation, unknown-key preservation, config generation, explicit-provision workflow checks, dynamic completions based on `extensions.txt` plus selected `--instance`, and extension-owned command dispatch.
- [X] Do not add integration tests for actual Plannotator product usage in Rootcell; that belongs with the Plannotator extension when it moves out.
- [X] Extension management commands, including `extension list`, seed/create instance config files when needed, so users can discover/enable extensions before first VM boot.
- [X] Add `extensions` to the existing `rootcell edit` targets so users can run `rootcell edit extensions`.
- [X] Keep `extensions.txt` host-side only. Do not copy it into the VM; Rootcell reads it and generates Nix hook aggregators/env behavior from it.
- [X] Extension management commands only edit `extensions.txt`; they do not automatically provision. After enable/disable, print a clear instance-qualified provision message, e.g. `run ./rootcell --instance <name> provision to apply VM changes`.

### Phase 2: Host tunnel primitive

Implementation update: the Phase 2 slice added shared tunnel helpers for local-port selection, role-target tunnel specs, and foreground tunnel lifecycle/close behavior; refactored `rootcell spy` to use those helpers while preserving its URL/output behavior; and added unit coverage for port fallback/exhaustion, role-target forwarding, SSH local-forward command construction/failure, and spy fallback/lifecycle wiring. Verification passed with `bun run typecheck`, `bun run lint`, `bun run test:unit:vitest`, and `git diff --check`.

- [X] Reuse the generic `VmProvider.forwardLocalPort` / SSH local-forwarding components from the spy browser branch, assuming they are likely merged before implementation.
- [X] Model tunnel metadata with target VM role (`agent` or `firewall`) plus remote host/port, so Plannotator can target the agent and future spy-like extensions can target the firewall.
- [X] Add generic tunnel primitive tests for SSH config/local-forward command construction, target role mapping, bind/remote host-port wiring, and tunnel lifecycle/close behavior.

### Phase 3: Plannotator extension package/install

Implementation update: the Phase 3 slice added a Nix package for `@plannotator/pi-extension@0.19.16`, pinned by npm tarball hash plus committed runtime dependency lock; installs a source-like package root with manifest, TypeScript files, browser HTML assets, skills, and `node_modules`; links it into Pi's extension auto-discovery tree through the enabled Home Manager hook; and sets/wraps Pi with `PLANNOTATOR_REMOTE=true` and `PLANNOTATOR_PORT=19432` without managing Pi settings. Verification passed with `bun run typecheck`, `bun run lint`, `bun run test:unit:vitest`, host-system Nix package build, and Home Manager module evals.

- [X] Package Plannotator through Nix/Home Manager, not runtime `pi install` inside the agent VM.
- [X] Fetch the published npm package `@plannotator/pi-extension`, pinned by version/hash, if it contains the needed source-like files and built HTML/generated assets.
- [X] Follow the existing Pi/subagent provisioning pattern: pinned Nix fetch/build inside VM provisioning, through the firewall-controlled network path, rather than a Rootcell host-side source cache.
- [X] Preserve a source-like package layout in the VM so Pi and the agent can inspect JS/TS extension code, similar to an npm-installed package, rather than only seeing an opaque bundled output.
- [X] Install/configure Plannotator using Pi's normal package model and package identity (`@plannotator/pi-extension`) rather than renaming it to the Rootcell extension id.
- [X] Let Nix control the pinned package content, while Pi loads it through normal package mechanisms.
- [X] Do not have Home Manager own/clobber `~/.pi/agent/settings.json`, because that is a user-editable Pi settings file.
- [X] Based on Pi code inspection, Pi loads settings only from `~/.pi/agent/settings.json` and `.pi/settings.json`; no separate Rootcell-managed settings fragment/include was found.
- [X] Use Pi auto-discovery/package-compatible filesystem locations instead. Pi auto-discovers `~/.pi/agent/extensions`, `skills`, `prompts`, and `themes`; for an extension directory, `package.json` with a `pi` manifest is honored before falling back to `index.ts`/`index.js`.
- [X] It is acceptable for Home Manager to manage specific Rootcell-owned files/subdirectories under these auto-discovery roots while leaving the parent directories user-writable.
- [X] Leave the exact package-compatible filesystem layout for Plannotator to the implementing agent, subject to the constraints above: do not own `settings.json`, preserve Pi's normal loading semantics, and keep package/source files inspectable.
- [X] Ensure Pi sessions receive `PLANNOTATOR_REMOTE=true` and `PLANNOTATOR_PORT=19432` when the Rootcell Plannotator extension is enabled by setting them in the Plannotator Home Manager module/user environment, not via one-off host session injection.

### Phase 4: Plannotator host command

Implementation update: the Phase 4 slice added `rootcell extension pi-plannotator tunnel` as an extension-owned host command in `src/rootcell/extensions/pi-plannotator.ts` and registered it from the built-in extension registry. The command requires `pi-plannotator=true` and a running agent VM, forwards host `127.0.0.1:<local>` to agent `127.0.0.1:19432` with local port fallback, prints the URL, and keeps the SSH tunnel in the foreground until Ctrl-C. It intentionally does not start/provision VMs, health-check Plannotator, launch a browser, or add background supervision. Tests in `src/rootcell/extensions/pi-plannotator.test.ts` cover enabled-state gating, completions, argument validation, VM-state failures, tunnel wiring, URL output, and foreground close behavior. Verification passed with `bun run typecheck`, `bun run lint`, `bun run test:unit:vitest`, and `git diff --check`.

- [X] Add a host command to open/hold the SSH tunnel through the firewall ProxyJump to the agent VM, forwarding host `127.0.0.1:<local>` to the Plannotator service on the agent (`127.0.0.1:19432` or agent private IP if binding requires it).
- [X] Require `pi-plannotator=true` before `rootcell extension pi-plannotator tunnel` runs; if disabled, fail with guidance to enable and provision. Dynamic completions should not offer this command path for instances where Plannotator is disabled.
- [X] Require an existing instance and the agent VM to already be running; do not seed, start, or provision from the tunnel command. Fail with guidance to enable/provision/start as appropriate.
- [X] Do not require or perform a Plannotator service health check before opening the tunnel; the expected workflow often starts the tunnel before Pi opens a Plannotator review server.
- [X] Keep the tunnel in the foreground until Ctrl-C; do not add background mode until Rootcell has an intentional process supervision/story for stopping background tunnels.
- [X] Print the host URL; do not automatically open a browser and do not add `--open` in the first iteration.
- [X] Print a concise message that the command is forwarding a localhost URL to the Plannotator server in the agent VM and that Ctrl-C stops the tunnel.
- [X] Prefer local port `19432`, but if it is busy choose another free localhost port and print the actual URL. The remote agent-side port remains `19432`.
- [X] Provide clear readiness/error messages.
- [X] Add Plannotator host-command tests for enabled-state gating, existing/running agent VM requirements, local port selection, `forwardLocalPort("agent", ...)` wiring, URL output, no browser launch, and no service health check.

### Phase 5: Documentation and migration

Implementation update: the Phase 5 documentation slice added a README Extensions section explaining per-instance opt-ins in `instances/<name>/extensions.txt`, management commands, explicit provision requirements, the Plannotator tunnel workflow, and the subagent migration. Related README examples were refreshed in Daily Workflow, Common Changes, Customize Pi, and Project Layout. Verification passed with a docs-focused `rg` check for the new extension terms and `git diff --check`.

- [X] Document the extension concept, commands, and Plannotator workflow.
- [X] Document the subagent migration clearly: existing VMs keep current files until explicit provision, but after provisioning with `pi-subagents=false`, Home Manager removes the previously managed subagent extension/example agents. Users who rely on it must run `./rootcell extension enable pi-subagents && ./rootcell provision`.
- [X] Add README examples.
