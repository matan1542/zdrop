import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runQuery, type QueryResult } from "../src/engine.js";
import { requestEnv } from "../src/learn/context.js";
import { gate } from "../src/learn/gate.js";
import { sandboxAvailable } from "../src/learn/sandbox.js";
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

describe("project-local tools", () => {
  const project = (name: string, sub: string) => {
    const root = tempDir(`proj-${name}`);
    const binDir = path.join(root, "node_modules", ".bin");
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(path.join(root, "packages", "web"), { recursive: true });
    fakeCli(binDir, "localtool", `Usage: localtool [command]\n\nCommands:\n  ${sub}   Only in ${name}\n  shared   Everywhere`);
    return root;
  };
  const one = project("one", "alpha");
  const two = project("two", "beta");
  const scripts = path.join(one, "scripts");
  fs.mkdirSync(scripts);
  const deploy = fakeCli(scripts, "deploy.sh", "Usage: deploy.sh [options]\n\nOptions:\n  --prod      Deploy to production\n  --dry-run   Print only");

  const askIn = async (line: string, cwd: string) => {
    const results: QueryResult[] = [];
    await requestEnv.run({ ...env, cwd }, () => runQuery(line, cwd, (r) => results.push(r)));
    return results.at(-1)!;
  };

  it("learns node_modules/.bin tools reached through npx, from any subfolder", async () => {
    expect(names(await askIn("npx localtool ", path.join(one, "packages", "web")))).toEqual(expect.arrayContaining(["alpha", "shared"]));
  });

  it("keeps the same tool name in different repos apart", async () => {
    const inTwo = names(await askIn("npx localtool ", two));
    expect(inTwo).toContain("beta");
    expect(inTwo).not.toContain("alpha");
    expect(names(await askIn("npx localtool ", one))).toContain("alpha");
  });

  it("learns scripts run by path", async () => {
    expect(names(await askIn("./scripts/deploy.sh --", one))).toEqual(expect.arrayContaining(["--prod", "--dry-run"]));
    expect(invocations(deploy)).toEqual(["--help"]);
  });
});

describe("safety", () => {
  it("kills a command whose --help hangs and remembers it", async () => {
    const started = Date.now();
    const results = await ask("hangcli ");
    expect(results.at(-1)!.items).toEqual([]);
    expect(Date.now() - started).toBeLessThan(6000);
    expect((await new LearnedStore().read("hangcli"))?.status).toBe("timeout");
    // pgrep itself, not through sh: Linux's pgrep would match the sh whose command line has the pattern
    expect(spawnSync("pgrep", ["-f", hang]).stdout.toString().trim()).toBe("");
    await ask("hangcli ");
    expect(invocations(hang)).toHaveLength(1);
  });

  it.runIf(sandboxAvailable())("runs --help in a sandbox: no writes outside, no network, no secrets", async () => {
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

    // without a sandbox, only commands the user typed are run
    expect((await gate("fakecli", cli, false)).action).toBe(sandboxAvailable() ? "probe" : "man");
    expect((await gate("fakecli", cli, true)).action).toBe("probe");
    expect((await gate("quiet", quiet, true)).action).toBe("man");
    expect((await gate("guiapp", launcher, true)).action).toBe("man");
    expect((await gate("shutdown", denied, true)).action).toBe("man");
    if (process.platform !== "darwin") return;
    // macOS system binaries
    expect((await gate("crontab", "/usr/bin/crontab", true)).reason).toMatch(/setuid/);
    expect((await gate("java", "/usr/bin/java", true)).reason).toMatch(/stub/);
    expect((await gate("zip", "/usr/bin/zip", false)).action).toBe("man");
    expect((await gate("zip", "/usr/bin/zip", true)).action).toBe("probe");
    expect((await gate("ping", "/sbin/ping", true)).reason).toMatch(/system directory/);
  });
});

describe("native completion protocols", () => {
  it("parses cobra, click and yargs answers", async () => {
    const { parseNative } = await import("../src/learn/native.js");
    expect(parseNative("cobra", "pod-a\tRunning\npod-b\n:4\n")).toEqual([
      { name: "pod-a", description: "Running" },
      { name: "pod-b", description: undefined },
    ]);
    expect(parseNative("cobra", "x\n:1\n")).toEqual([]);
    expect(parseNative("cobra", "x\n:2\n")).toEqual([{ name: "x", description: undefined, insertValue: "x" }]);
    expect(parseNative("cobra", "Error: unknown command\n")).toBeUndefined();
    expect(parseNative("click", "plain\nprod\nProduction\nplain\ndev\n_\nfile\n\n_\n")).toEqual([
      { name: "prod", description: "Production" },
      { name: "dev", description: undefined },
    ]);
    expect(parseNative("click", "Usage: tool\n")).toBeUndefined();
    expect(parseNative("yargs", "serve:start the server\nbuild\\:prod\n--help\n")).toEqual([
      { name: "serve", description: "start the server" },
      { name: "build:prod", description: undefined },
    ]);
  });

  it("asks a cobra program for live argument values, after detecting it in the sandbox", async () => {
    const nativeBin = tempDir("native-bin");
    const cobraHelp = `fakecobra manages pods.

Usage:
  fakecobra [command]

Available Commands:
  get         Display pods
  help        Help about any command

Flags:
  -h, --help   help for fakecobra

Use "fakecobra [command] --help" for more information about a command.`;
    const getHelp = `Display pods.

Usage:
  fakecobra get [flags]

Flags:
  -h, --help   help for get
  -w, --watch  Watch for changes`;
    const cobra = fakeCli(
      nativeBin,
      "fakecobra",
      cobraHelp,
      { get: getHelp },
      `if [ "$1" = "__complete" ]; then shift
  if [ "$1" = "get" ]; then printf 'pod-alpha\\tRunning\\npod-beta\\tPending\\n:4\\n'; else printf 'get\\tDisplay pods\\n:4\\n'; fi
  exit 0
fi`,
    );
    const nativeEnv = { path: `${nativeBin}:/usr/bin:/bin` };
    const results: QueryResult[] = [];
    await requestEnv.run(nativeEnv, () => runQuery("fakecobra get ", nativeBin, (r) => results.push(r)));
    // learned (root help, the sandboxed __complete probe, `get --help`), then asked for values
    expect(names(results.at(-1)!)).toEqual(expect.arrayContaining(["pod-alpha", "pod-beta"]));
    expect(results.at(-1)!.items.find((i) => i.name === "pod-alpha")?.description).toBe("Running");
    expect(invocations(cobra)).toEqual(expect.arrayContaining(["--help", "__complete ", "get --help", "__complete get "]));
    expect((await new LearnedStore().read("fakecobra"))?.protocol).toBe("cobra");
  });
});
