import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runQuery, type QueryResult } from "../src/engine.js";
import { requestEnv } from "../src/learn/context.js";
import { gate } from "../src/learn/gate.js";
import { LearnedStore } from "../src/learn/store.js";
import { initRuntime, type Runtime } from "../src/setup.js";
import { fakeCli, invocations, tempDir, waitFor } from "./helpers.js";

const bin = tempDir("learn-bin");
const env = { path: `${bin}:/usr/bin:/bin` };

const rootHelp = `Usage: fakecli [options] [command]

A fake deployment tool

Options:
  -v, --verbose          Verbose output
  --env <name>           Target environment (choices: "dev", "staging", "prod")
  -h, --help             Display help for command

Commands:
  deploy [options] <target>   Deploy a target
  status                      Show status`;

const deployHelp = `Usage: fakecli deploy [options] <target>

Deploy a target

Options:
  --force       Skip checks
  --dry-run     Print what would happen
  -h, --help    Display help for command`;

const cli = fakeCli(bin, "fakecli", rootHelp, { deploy: deployHelp });
// created up front: the PATH index re-reads a directory at most every 15s
const prefetched = fakeCli(bin, "prefetchme", rootHelp);
const hang = fakeCli(bin, "hangcli", rootHelp, {}, "sleep 30");
const outside = path.join(os.homedir(), `.zdrop-sandbox-test-${process.pid}`);
fakeCli(
  bin,
  "evilcli",
  rootHelp,
  {},
  `touch '${outside}'
/usr/bin/curl -s -m 2 -o /dev/null https://example.com && printf 'Commands:\\n  network-reached   bad\\n'
printf 'Commands:\\n  leak-%s   secret\\n' "$ZDROP_TEST_SECRET"
cat "$HOME/../../.ssh/config" >/dev/null 2>&1 && printf 'Commands:\\n  ssh-read   bad\\n'`,
);

let runtime: Runtime;
const fresh = () => {
  runtime?.learner?.dispose();
  runtime = initRuntime();
  return runtime;
};

/** All results of one query (the first may be the pending/loading one). */
const ask = async (line: string): Promise<QueryResult[]> => {
  const results: QueryResult[] = [];
  await requestEnv.run(env, () => runQuery(line, bin, (r) => results.push(r)));
  return results;
};
const names = (r: QueryResult) => r.items.map((i) => i.name);

beforeAll(() => {
  fresh();
});
afterAll(() => runtime.learner?.dispose());

describe("learning a command from --help", () => {
  it("shows a loading state, then the learned subcommands and options", async () => {
    const results = await ask("fakecli ");
    expect(results[0].pending).toEqual(["fakecli --help"]);
    expect(results[0].items).toEqual([]);
    expect(names(results.at(-1)!)).toEqual(expect.arrayContaining(["deploy", "status"]));
    expect(invocations(cli)).toEqual(["--help"]);
  });

  it("answers from the cache afterwards without running anything", async () => {
    const results = await ask("fakecli ");
    expect(results).toHaveLength(1);
    expect(names(results[0])).toContain("deploy");
    expect((await ask("fakecli --env "))[0].items.map((i) => i.name)).toEqual(expect.arrayContaining(["dev", "staging", "prod"]));
    expect(invocations(cli)).toEqual(["--help"]);
  });

  it("learns a subcommand only when it is reached", async () => {
    const results = await ask("fakecli deploy --");
    expect(results[0].pending).toEqual(["fakecli deploy --help"]);
    expect(names(results.at(-1)!)).toEqual(expect.arrayContaining(["--force", "--dry-run"]));
    expect(invocations(cli)).toEqual(["--help", "deploy --help"]);
  });

  it("reuses what is on disk after a restart", async () => {
    fresh();
    const results = await ask("fakecli deploy --");
    expect(results).toHaveLength(1);
    expect(names(results[0])).toContain("--force");
    expect(invocations(cli)).toHaveLength(2);
  });

  it("lists PATH commands for the first word, with learned descriptions", async () => {
    await runtime.learner!.store.loadIndex();
    const [result] = await ask("fakec");
    const item = result.items.find((i) => i.name === "fakecli");
    expect(item?.description).toBe("A fake deployment tool");
  });

  it("re-learns a binary that changed, answering from the old spec meanwhile", async () => {
    fs.appendFileSync(cli, "# changed\n");
    fs.utimesSync(cli, new Date(), new Date(Date.now() + 5000));
    fresh();
    const results = await ask("fakecli ");
    expect(results).toHaveLength(1);
    expect(names(results[0])).toContain("deploy");
    await waitFor(() => invocations(cli).length === 3);
    expect(invocations(cli).at(-1)).toBe("--help");
  });

  it("prefetches the only matching command once typing pauses", async () => {
    requestEnv.run(env, () => runtime.learner!.prefetch("prefetchm"));
    await waitFor(() => invocations(prefetched).length === 1);
    await waitFor(() => runtime.learner!.store.descriptions.has("prefetchme"));
  });
});

describe("safety", () => {
  it("kills a command whose --help hangs and remembers it", async () => {
    const started = Date.now();
    const results = await ask("hangcli ");
    expect(results.at(-1)!.items).toEqual([]);
    expect(Date.now() - started).toBeLessThan(6000);
    expect((await new LearnedStore().read("hangcli"))?.status).toBe("timeout");
    expect(execFileSync("/bin/sh", ["-c", `pgrep -f '${hang}' || true`]).toString().trim()).toBe("");
    await ask("hangcli ");
    expect(invocations(hang)).toHaveLength(1);
  });

  it("runs --help in a sandbox: no writes outside, no network, no secrets", async () => {
    process.env.ZDROP_TEST_SECRET = "s3cret-value";
    const results = await ask("evilcli ");
    const learned = names(results.at(-1)!);
    expect(learned).toContain("deploy");
    expect(fs.existsSync(outside)).toBe(false);
    expect(learned.join(" ")).not.toMatch(/network-reached|s3cret|ssh-read/);
    // the probe did print its environment-dependent line, just without the secret
    expect(learned).toContain("leak-");
    fs.rmSync(outside, { force: true });
  });

  it("gate: never executes risky commands", async () => {
    const quiet = path.join(bin, "quiet");
    fs.writeFileSync(quiet, "#!/bin/sh\nrm -rf /tmp/nothing-here\n", { mode: 0o755 });
    const launcher = path.join(bin, "guiapp");
    fs.writeFileSync(launcher, '#!/bin/bash\nJAVA_HOME=/x exec /opt/app/run "$@"\n', { mode: 0o755 });
    const denied = fakeCli(bin, "shutdown", rootHelp);

    expect((await gate("fakecli", cli, false)).action).toBe("probe");
    expect((await gate("quiet", quiet, true)).action).toBe("man");
    expect((await gate("guiapp", launcher, true)).action).toBe("man");
    expect((await gate("shutdown", denied, true)).action).toBe("man");
    expect((await gate("crontab", "/usr/bin/crontab", true)).reason).toMatch(/setuid/);
    expect((await gate("java", "/usr/bin/java", true)).reason).toMatch(/stub/);
    expect((await gate("zip", "/usr/bin/zip", false)).action).toBe("man");
    expect((await gate("zip", "/usr/bin/zip", true)).action).toBe("probe");
    expect((await gate("ping", "/sbin/ping", true)).reason).toMatch(/system directory/);
  });
});
