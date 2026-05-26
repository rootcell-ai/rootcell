import { describe, expect, test } from "vitest";
import type { LocalPortForwardOptions, VmRole } from "./providers/types.ts";
import {
  chooseLocalPort,
  openRoleTargetTunnel,
  waitForForegroundTunnel,
  type RoleTargetTunnelSpec,
} from "./tunnels.ts";

type SignalName = "SIGINT" | "SIGTERM";

class FakeSignalEvents {
  private readonly listeners = new Map<SignalName, Set<() => void>>();

  once(signal: SignalName, listener: () => void): void {
    const listeners = this.listeners.get(signal) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(signal, listeners);
  }

  removeListener(signal: SignalName, listener: () => void): void {
    this.listeners.get(signal)?.delete(listener);
  }

  emit(signal: SignalName): void {
    const listeners = [...(this.listeners.get(signal) ?? [])];
    this.listeners.delete(signal);
    for (const listener of listeners) {
      listener();
    }
  }

  count(signal: SignalName): number {
    return this.listeners.get(signal)?.size ?? 0;
  }
}

describe("rootcell tunnels", () => {
  test("chooses the preferred local port when it is available", async () => {
    const checked: string[] = [];

    const chosen = await chooseLocalPort(19_432, "127.0.0.1", 100, (port, host) => {
      checked.push(`${host}:${String(port)}`);
      return Promise.resolve(true);
    });

    expect(chosen).toBe(19_432);
    expect(checked).toEqual(["127.0.0.1:19432"]);
  });

  test("falls back to the next available local port", async () => {
    const checked: number[] = [];

    const chosen = await chooseLocalPort(19_432, "127.0.0.1", 100, (port) => {
      checked.push(port);
      return Promise.resolve(port === 19_434);
    });

    expect(chosen).toBe(19_434);
    expect(checked).toEqual([19_432, 19_433, 19_434]);
  });

  test("fails clearly when the scan limit is exhausted", async () => {
    const checked: number[] = [];

    await expect(chooseLocalPort(19_432, "127.0.0.1", 3, (port) => {
      checked.push(port);
      return Promise.resolve(false);
    })).rejects.toThrow("no available local port found starting at 19432");

    expect(checked).toEqual([19_432, 19_433, 19_434]);
  });

  test.each([
    { role: "agent" as const, remoteHost: "127.0.0.1", remotePort: 19_432 },
    { role: "firewall" as const, remoteHost: "10.0.0.10", remotePort: 6174 },
  ])("opens a role-target tunnel for $role", async ({ role, remoteHost, remotePort }) => {
    const calls: { role: VmRole; options: LocalPortForwardOptions }[] = [];
    const spec: RoleTargetTunnelSpec = {
      role,
      remoteHost,
      remotePort,
      preferredLocalPort: 19_432,
    };

    const tunnel = await openRoleTargetTunnel(
      (forwardRole, options) => {
        calls.push({ role: forwardRole, options });
        return Promise.resolve({
          ...options,
          closed: Promise.resolve(0),
          close: () => Promise.resolve(),
        });
      },
      spec,
      {
        scanLimit: 2,
        portAvailable: (port) => Promise.resolve(port !== 19_432),
      },
    );

    expect(tunnel.role).toBe(role);
    expect(tunnel.localHost).toBe("127.0.0.1");
    expect(tunnel.localPort).toBe(19_433);
    expect(calls).toEqual([
      {
        role,
        options: {
          localHost: "127.0.0.1",
          localPort: 19_433,
          remoteHost,
          remotePort,
        },
      },
    ]);
  });

  test("propagates tunnel startup failures", async () => {
    await expect(openRoleTargetTunnel(
      () => Promise.reject(new Error("provider forward failed")),
      {
        role: "agent",
        localHost: "127.0.0.1",
        remoteHost: "127.0.0.1",
        remotePort: 19_432,
        preferredLocalPort: 19_432,
      },
      {
        portAvailable: () => Promise.resolve(true),
      },
    )).rejects.toThrow("provider forward failed");
  });

  test("waits in the foreground, reports closed tunnels, and closes the handle", async () => {
    const logs: string[] = [];
    let closeCalls = 0;

    const status = await waitForForegroundTunnel({
      closed: Promise.resolve(7),
      close: () => {
        closeCalls += 1;
        return Promise.resolve();
      },
    }, { log: (message) => logs.push(message) });

    expect(status).toBe(1);
    expect(closeCalls).toBe(1);
    expect(logs).toEqual(["SSH tunnel closed."]);
  });

  test("returns signal statuses and closes the tunnel on Ctrl-C", async () => {
    const signalEvents = new FakeSignalEvents();
    let closeCalls = 0;
    let resolveClosed: (status: number) => void = () => undefined;
    const closed = new Promise<number>((resolve) => {
      resolveClosed = resolve;
    });

    const waiting = waitForForegroundTunnel({
      closed,
      close: () => {
        closeCalls += 1;
        resolveClosed(0);
        return Promise.resolve();
      },
    }, { signalEvents });

    expect(signalEvents.count("SIGINT")).toBe(1);
    signalEvents.emit("SIGINT");

    await expect(waiting).resolves.toBe(130);
    expect(closeCalls).toBe(1);
    expect(signalEvents.count("SIGINT")).toBe(0);
    expect(signalEvents.count("SIGTERM")).toBe(0);
  });
});
