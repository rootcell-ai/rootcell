import yargs from "yargs/yargs";
import type { Argv, ArgumentsCamelCase } from "yargs";
import { completeExtensionCommand } from "./extensions/commands.ts";
import { isRootcellSubcommand, ROOTCELL_SUBCOMMANDS, type RootcellSubcommand } from "./metadata.ts";
import { listRootcellInstanceNames, validateInstanceName } from "./instance.ts";
import { parseSchema } from "./schema.ts";
import {
  ParsedRootcellInitEnvArgsSchema,
  ParsedRootcellHandledArgsSchema,
  ParsedRootcellRunArgsSchema,
  ROOTCELL_INIT_ENV_PROVIDER_TYPES,
  RootcellInitEnvProviderTypeSchema,
  SpyOptionsSchema,
  type ParsedRootcellArgs,
  type SpyOptions,
} from "./types.ts";

const DEFAULT_SPY_OPTIONS: SpyOptions = { open: true };

interface GlobalArgs {
  readonly instance?: string | readonly string[];
  readonly initEnv?: string | readonly string[];
}

interface GuestArgs extends GlobalArgs {
  readonly command?: readonly string[];
  readonly "--"?: readonly string[];
}

interface SpyArgs extends GlobalArgs {
  readonly open?: boolean;
}

interface EditArgs extends GlobalArgs {
  readonly target?: string;
}

interface ExtensionArgs extends GlobalArgs {
  readonly extensionArgs?: readonly string[];
}

type ParserArgv<T> = Argv<T>;

function subcommandDescription(name: RootcellSubcommand): string {
  return ROOTCELL_SUBCOMMANDS.find((subcommand) => subcommand.name === name)?.description ?? "";
}

function lastString(value: string | readonly string[] | undefined): string | undefined {
  if (typeof value === "string" || value === undefined) {
    return value;
  }
  return value[value.length - 1];
}

function instanceName(argv: GlobalArgs): string {
  return validateInstanceName(lastString(argv.instance) ?? "default");
}

function stringArray(value: unknown): readonly string[] {
  if (value === undefined) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map(argString);
  }
  return [argString(value)];
}

function argString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return value.toString();
  }
  throw new Error(`invalid command argument value: ${JSON.stringify(value)}`);
}

function rootcellSubcommand(
  name: RootcellSubcommand,
  builder?: (argv: ParserArgv<GlobalArgs>) => ParserArgv<GlobalArgs>,
): readonly [
  string,
  string,
  (argv: ParserArgv<GlobalArgs>) => ParserArgv<GlobalArgs>,
] {
  return [
    name,
    subcommandDescription(name),
    (argv) => (builder?.(argv) ?? argv).demandCommand(0, 0).strictOptions(),
  ];
}

function completeInstances(current: string): readonly string[] {
  return listRootcellInstanceNames(process.cwd())
    .filter((name) => name.startsWith(current));
}

function completion(
  current: string,
  argv: ArgumentsCamelCase<GlobalArgs>,
  completionFilter: (done: (error: Error | null, completions: string[] | undefined) => void) => void,
  done: (completions: string[]) => void,
): void {
  const currentInstance = lastString(argv.instance);
  if (currentInstance === current) {
    done([...completeInstances(current)]);
    return;
  }

  const extensionCompletions = completeExtensionCompletion(current, argv);
  if (extensionCompletions !== undefined) {
    done([...extensionCompletions]);
    return;
  }

  completionFilter((error, completions) => {
    if (error !== null) {
      throw error;
    }
    const defaults = (completions ?? []).filter((completion) => !completion.startsWith("$0"));
    done(defaults);
  });
}

function completeExtensionCompletion(
  current: string,
  argv: ArgumentsCamelCase<GlobalArgs>,
): readonly string[] | undefined {
  const rawWords = argv._.map((value) => String(value));
  const words = rawWords[0] === "rootcell" ? rawWords.slice(1) : rawWords;
  const instance = lastString(argv.instance) ?? "default";
  try {
    return completeExtensionCommand({
      repoDir: process.cwd(),
      env: process.env,
      instanceName: instance,
      words,
      current,
    });
  } catch {
    return [];
  }
}

function createParser(args: readonly string[]): Argv<GuestArgs & SpyArgs & ExtensionArgs> {
  return yargs([...args])
    .scriptName("rootcell")
    .exitProcess(false)
    .version(false)
    .parserConfiguration({
      "greedy-arrays": false,
      "populate--": true,
      "unknown-options-as-args": true,
    })
    .usage("$0 [command..]\n\nStart the rootcell agent VM and run a command.")
    .option("instance", {
      alias: "i",
      describe: "select rootcell instance",
      type: "string",
      default: "default",
      normalize: false,
    })
    .option("init-env", {
      choices: ROOTCELL_INIT_ENV_PROVIDER_TYPES,
      describe: "initialize the selected instance environment for a provider",
      type: "string",
    })
    // yargs' completion request flag is normally implicit. With
    // unknown-options-as-args enabled for command pass-through, it must be
    // declared so completion requests still reach yargs.
    .option("get-yargs-completions", {
      type: "string",
      hidden: true,
    })
    .command(...rootcellSubcommand("provision"))
    .command(...rootcellSubcommand("allow"))
    .command(...rootcellSubcommand("pubkey"))
    .command(...rootcellSubcommand("list"))
    .command(...rootcellSubcommand("stop"))
    .command(...rootcellSubcommand("remove"))
    .command(
      "edit <target>",
      subcommandDescription("edit"),
      (argv: ParserArgv<EditArgs>) => argv
        .positional("target", {
          choices: ["env", "http", "https", "dns", "ssh", "extensions"],
          describe: "instance file to edit",
          type: "string",
        })
        .demandCommand(0, 0)
        .strictOptions(),
    )
    .command(
      "extension [extensionArgs..]",
      subcommandDescription("extension"),
      (argv: ParserArgv<ExtensionArgs>) => argv
        .positional("extensionArgs", {
          array: true,
          describe: "extension command and arguments",
          type: "string",
        })
        .demandCommand(0, 0)
        .strictOptions(),
    )
    .command(
      "spy",
      subcommandDescription("spy"),
      (argv: ParserArgv<SpyArgs>) => argv
        .parserConfiguration({ "unknown-options-as-args": false })
        .option("open", {
          describe: "open the browser after starting the local tunnel; use --no-open to disable",
          type: "boolean",
          default: true,
        })
        .demandCommand(0, 0)
        .strictOptions(),
    )
    .command(
      "$0 [command..]",
      "run a command inside the agent VM; defaults to an interactive shell",
      (argv: ParserArgv<GuestArgs>) => argv.positional("command", {
        array: true,
        describe: "command and arguments to run inside the agent VM",
        type: "string",
      }),
    )
    .example("$0", "open an interactive shell inside the agent VM")
    .example("$0 pi", "run pi inside the agent VM")
    .example("$0 -- nix flake update", "run any command inside the agent VM")
    .example("$0 edit env", "edit the default instance environment in $EDITOR")
    .example("$0 edit http", "edit the HTTPS allowlist for the default instance")
    .example("$0 --instance dev edit dns", "edit the DNS allowlist for the dev instance")
    .example("$0 --instance dev allow", "reload allowlists for the dev instance")
    .example("$0 --instance aws-dev --init-env aws-ec2", "initialize an AWS EC2 instance environment")
    .example("$0 list", "list rootcell VMs and their current state")
    .example("$0 stop --instance dev", "stop the dev instance VMs")
    .example("$0 remove --instance dev", "delete the dev instance VM state")
    .completion("completion", "generate shell completion script", completion)
    .help()
    .wrap(Math.min(100, yargs().terminalWidth()))
    .fail(fail);
}

export function parseRootcellArgs(args: readonly string[]): ParsedRootcellArgs {
  rejectUnknownSpyHelpOptions(args);
  const argv = createParser(args).parseSync();
  const firstToken = firstRootcellToken(args);
  if (
    argv.help === true
    || firstToken === "help"
    || firstToken === "completion"
    || argv["get-yargs-completions"] !== undefined
  ) {
    return parseSchema(ParsedRootcellHandledArgsSchema, { kind: "handled", status: 0 }, "invalid parsed rootcell args");
  }

  const subcommand = parsedSubcommand(argv);
  const initEnv = lastString(argv.initEnv);
  if (initEnv !== undefined) {
    if (subcommand !== undefined || stringArray(argv.command).length > 0 || stringArray(argv["--"]).length > 0) {
      throw new Error("--init-env cannot be combined with a rootcell command");
    }
    return parseSchema(ParsedRootcellInitEnvArgsSchema, {
      kind: "init-env",
      instanceName: instanceName(argv),
      providerType: parseSchema(RootcellInitEnvProviderTypeSchema, initEnv, "invalid --init-env provider"),
    }, "invalid parsed rootcell args");
  }

  if (subcommand !== undefined) {
    const rest = subcommand === "edit"
      ? [argString((argv as ArgumentsCamelCase<EditArgs>).target)]
      : subcommand === "extension"
        ? stringArray((argv as ArgumentsCamelCase<ExtensionArgs>).extensionArgs)
        : [];
    return parseSchema(ParsedRootcellRunArgsSchema, {
      kind: "run",
      instanceName: instanceName(argv),
      subcommand,
      rest,
      spyOptions: subcommand === "spy"
        ? parseSchema(SpyOptionsSchema, {
          open: argv.open ?? true,
        }, "invalid spy options")
        : DEFAULT_SPY_OPTIONS,
    }, "invalid parsed rootcell args");
  }

  const afterTerminator = stringArray(argv["--"]);
  const rest = [...stringArray(argv.command), ...afterTerminator];
  const first = rest[0];
  if (first?.startsWith("-") === true && afterTerminator.length === 0) {
    throw new Error(`Unknown argument: ${first.replace(/^-+/, "")}`);
  }
  return parseSchema(ParsedRootcellRunArgsSchema, {
    kind: "run",
    instanceName: instanceName(argv),
    subcommand: "",
    rest,
    spyOptions: DEFAULT_SPY_OPTIONS,
  }, "invalid parsed rootcell args");
}

function fail(message: string, error: Error): never {
  throw error instanceof Error ? error : new Error(message);
}

function parsedSubcommand(argv: ArgumentsCamelCase<GuestArgs & SpyArgs & ExtensionArgs>): RootcellSubcommand | undefined {
  const command = argv._[0];
  return typeof command === "string" && isRootcellSubcommand(command) ? command : undefined;
}

function rejectUnknownSpyHelpOptions(args: readonly string[]): void {
  const firstToken = firstRootcellTokenWithIndex(args);
  if (firstToken?.token !== "spy" || !args.includes("--help")) {
    return;
  }

  for (let index = firstToken.index + 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined || arg === "--") {
      return;
    }
    if (!arg.startsWith("-")) {
      continue;
    }
    if (arg === "--help" || arg === "--open" || arg === "--no-open" || arg.startsWith("--open=")) {
      continue;
    }
    if (arg === "--instance" || arg === "-i" || arg === "--init-env" || arg === "--get-yargs-completions") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--instance=") || arg.startsWith("--init-env=") || arg.startsWith("--get-yargs-completions=") || (arg.startsWith("-i") && arg.length > 2)) {
      continue;
    }
    throw new Error(`Unknown argument: ${unknownOptionName(arg)}`);
  }
}

function unknownOptionName(arg: string): string {
  const name = arg.replace(/^-+/, "").split("=")[0] ?? "";
  return name.startsWith("no-") ? name.slice(3) : name;
}

function firstRootcellToken(args: readonly string[]): string | undefined {
  return firstRootcellTokenWithIndex(args)?.token;
}

function firstRootcellTokenWithIndex(args: readonly string[]): { readonly token: string; readonly index: number } | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined || arg === "--") {
      return undefined;
    }
    if (arg === "--instance" || arg === "-i" || arg === "--init-env" || arg === "--get-yargs-completions") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--instance=") || arg.startsWith("--init-env=") || (arg.startsWith("-i") && arg.length > 2)) {
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    return { token: arg, index };
  }
  return undefined;
}
