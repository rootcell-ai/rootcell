import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { LocalPortForwardOptions, LocalPortForwardHandle, VmRole, VmStatus } from "../providers/types.ts";
import type { RootcellConfig } from "../types.ts";
import { completeExtensionCommand, runExtensionCommand } from "./commands.ts";
import { parseExtensionsConfig } from "./config.ts";
import { createPlannotatorTunnelCommand } from "./pi-plannotator.ts";
import type { ExtensionHostCommandContext } from "./registry.ts";

describe("pi-plannotator extension host command", () => {
  test("disabled extension gating prevents context creation", async () => {
    const repo = makeRepo();
    try {
      const stateDir = join(repo, ".state");
      const instanceDir = join(stateDir, "dev");
      const logs: string[] = [];
      let contexts = 0;
      mkdirSync(instanceDir, { recursive: true });
      writeFileSync(join(instanceDir, "extensions.txt"), "pi-plannotator=false\npi-subagents=false\n", "utf8");

      const status = await runExtensionCommand({
        repoDir: repo,
        env: { ...process.env, ROOTCELL_STATE_DIR: stateDir },
        instanceName: "dev",
        rest: ["pi-plannotator", "tunnel"],
        log: (message) => logs.push(message),
        createContext: () => {
          contexts += 1;
          return testContext();
        },
      });

      expect(status).toBe(1);
      expect(contexts).toBe(0);
      expect(logs.join("\n")).toContain("extension 'pi-plannotator' is disabled");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("completions expose tunnel only when Plannotator is enabled", () => {
    const repo = makeRepo();
    try {
      const stateDir = join(repo, ".state");
      const instanceDir = join(stateDir, "dev");
      const env = { ...process.env, ROOTCELL_STATE_DIR: stateDir };
      mkdirSync(instanceDir, { recursive: true });
      writeFileSync(join(instanceDir, "extensions.txt"), "pi-plannotator=true\npi-subagents=false\n", "utf8");

      expect(completeExtensionCommand({
        repoDir: repo,
        env,
        instanceName: "dev",
        words: ["extension", ""],
        current: "",
      })).toContain("pi-plannotator");
      expect(completeExtensionCommand({
        repoDir: repo,
        env,
        instanceName: "dev",
        words: ["extension", "pi-plannotator", ""],
        current: "",
      })).toEqual(["tunnel"]);
      expect(completeExtensionCommand({
        repoDir: repo,
        env,
        instanceName: "dev",
        words: ["extension", "pi-plannotator", "tunnel", ""],
        current: "",
      })).toEqual([]);

      writeFileSync(join(instanceDir, "extensions.txt"), "pi-plannotator=false\npi-subagents=false\n", "utf8");
      expect(completeExtensionCommand({
        repoDir: repo,
        env,
        instanceName: "dev",
        words: ["extension", ""],
        current: "",
      })).not.toContain("pi-plannotator");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("rejects extra tunnel arguments before checking VM state", async () => {
    const logs: string[] = [];
    let statusChecks = 0;
    const command = createPlannotatorTunnelCommand();

    const status = await command.run(testContext({
      logs,
      vmStatus: () => {
        statusChecks += 1;
        return Promise.resolve({ state: "running" });
      },
    }), ["extra"]);

    expect(status).toBe(2);
    expect(statusChecks).toBe(0);
    expect(logs).toEqual(["usage: rootcell extension pi-plannotator tunnel"]);
  });

  test.each([
    {
      label: "missing",
      vmStatus: { state: "missing" } satisfies VmStatus,
      expected: "agent VM for instance 'dev' is missing",
    },
    {
      label: "stopped",
      vmStatus: { state: "stopped" } satisfies VmStatus,
      expected: "agent VM for instance 'dev' is stopped",
    },
    {
      label: "unexpected",
      vmStatus: { state: "unexpected", detail: "provider error" } satisfies VmStatus,
      expected: "agent VM for instance 'dev' is not ready: provider error",
    },
  ])("requires a running agent VM when it is $label", async ({ vmStatus, expected }) => {
    const logs: string[] = [];
    let forwards = 0;
    const command = createPlannotatorTunnelCommand();

    const status = await command.run(testContext({
      logs,
      vmStatus: () => Promise.resolve(vmStatus),
      forwardLocalPort: () => {
        forwards += 1;
        return Promise.resolve(testTunnelHandle());
      },
    }), []);

    expect(status).toBe(1);
    expect(forwards).toBe(0);
    expect(logs.join("\n")).toContain(expected);
  });

  test("opens a foreground agent tunnel, prints the URL, and closes the handle", async () => {
    const logs: string[] = [];
    const calls: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    let forwarded: { role: VmRole; options: LocalPortForwardOptions } | undefined;
    let closeCalls = 0;
    const command = createPlannotatorTunnelCommand({
      portAvailable: (port, host) => {
        calls.push(`port:${host}:${String(port)}`);
        return Promise.resolve(port === 19_433);
      },
    });

    try {
      const status = await command.run(testContext({
        logs,
        vmStatus: (role) => {
          calls.push(`status:${role}`);
          return Promise.resolve({ state: "running" });
        },
        forwardLocalPort: (role, options) => {
          calls.push(`forward:${role}`);
          forwarded = { role, options };
          return Promise.resolve({
            ...options,
            closed: Promise.resolve(0),
            close: () => {
              closeCalls += 1;
              calls.push("close");
              return Promise.resolve();
            },
          });
        },
      }), []);

      expect(status).toBe(0);
      expect(forwarded).toEqual({
        role: "agent",
        options: {
          localHost: "127.0.0.1",
          localPort: 19_433,
          remoteHost: "127.0.0.1",
          remotePort: 19_432,
        },
      });
      expect(stdout.mock.calls.map((call) => String(call[0])).join("")).toBe("http://127.0.0.1:19433\n");
      expect(logs).toContain("forwarding http://127.0.0.1:19433 to Plannotator in the agent VM (Ctrl-C stops the tunnel).");
      expect(closeCalls).toBe(1);
      expect(calls).toEqual([
        "status:agent",
        "port:127.0.0.1:19432",
        "port:127.0.0.1:19433",
        "forward:agent",
        "close",
      ]);
    } finally {
      stdout.mockRestore();
    }
  });
});

function makeRepo(): string {
  return mkdtempSync(join(tmpdir(), "rootcell-pi-plannotator-"));
}

function testContext(input: {
  readonly logs?: string[];
  readonly vmStatus?: (role: VmRole) => Promise<VmStatus>;
  readonly forwardLocalPort?: (role: VmRole, options: LocalPortForwardOptions) => Promise<LocalPortForwardHandle>;
} = {}): ExtensionHostCommandContext {
  return {
    repoDir: "/repo",
    instanceName: "dev",
    extensionConfig: parseExtensionsConfig("pi-plannotator=true\npi-subagents=false\n"),
    config: {} as RootcellConfig,
    log: (message) => input.logs?.push(message),
    vmStatus: input.vmStatus ?? (() => Promise.resolve({ state: "running" })),
    forwardLocalPort: input.forwardLocalPort ?? ((_role, options) => Promise.resolve(testTunnelHandle(options))),
  };
}

function testTunnelHandle(options: LocalPortForwardOptions = {
  localHost: "127.0.0.1",
  localPort: 19_432,
  remoteHost: "127.0.0.1",
  remotePort: 19_432,
}): LocalPortForwardHandle {
  return {
    ...options,
    closed: Promise.resolve(0),
    close: () => Promise.resolve(),
  };
}
