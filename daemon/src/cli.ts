// first: the config file sets ZDROP_* variables before any module reads them
import "./config.js";
import { runQuery } from "./engine.js";
import { initRuntime } from "./setup.js";

const usage = `usage:
  zdrop query "<command line>" [--cwd <dir>]   print suggestions as JSON (runs in-process)
  zdrop serve                                  run the daemon in the foreground
  zdrop status                                 print the running daemon's memory and cache stats
  zdrop stop                                   stop the running daemon
  zdrop learn <command> [subcommand...]        learn a command from --help / man now and print the result
  zdrop why <command>                          where a command's completions come from, and why
  zdrop forget <command>|--all                 drop learned completions (relearned on next use)
  zdrop doctor [--markdown]                    check the setup, with a fix for each problem
  zdrop config [edit]                          show every setting and where it comes from / edit the file
  zdrop extras install                         download the aws, gcloud and az specs (release installs)
  zdrop version | update [version] | uninstall`;

const main = async (argv: string[]) => {
  const [command, ...rest] = argv;
  switch (command) {
    case "query": {
      const cwdIndex = rest.indexOf("--cwd");
      const cwd = cwdIndex === -1 ? process.cwd() : rest[cwdIndex + 1];
      const line = (cwdIndex === -1 ? rest : rest.filter((_, i) => i !== cwdIndex && i !== cwdIndex + 1)).join(" ");
      const { learner } = initRuntime();
      await learner?.store.loadIndex();
      const { requestEnv } = await import("./learn/context.js");
      await requestEnv.run({ path: process.env.PATH ?? "/usr/bin:/bin", cwd }, () =>
        runQuery(line, cwd, (result) => process.stdout.write(JSON.stringify(result) + "\n")),
      );
      learner?.dispose();
      return;
    }
    case "learn":
    case "why": {
      const [name, ...words] = rest;
      if (!name) throw new Error(`usage: zdrop ${command} <command>`);
      const { learner } = initRuntime();
      if (learner == null) throw new Error("learning is off (ZDROP_LEARN=0)");
      try {
        if (command === "why") {
          process.stdout.write(JSON.stringify(await learner.why(name), null, 2) + "\n");
        } else {
          const learned = await learner.learnNow(name, words);
          const node = learned?.nodes[words.join("/")];
          process.stdout.write(JSON.stringify(learned == null ? { name, learned: false } : { name, status: learned.status, source: learned.source, ...(node ?? {}) }, null, 2) + "\n");
        }
      } finally {
        learner.dispose();
      }
      return;
    }
    case "doctor": {
      const { defaultDoctorEnv, printDoctor, runDoctor } = await import("./doctor.js");
      const { request } = await import("./client.js");
      const env = defaultDoctorEnv();
      env.status = async () => {
        try {
          return JSON.parse(await request("S")) as Record<string, unknown>;
        } catch {
          return undefined;
        }
      };
      const checks = await runDoctor(env);
      if (rest.includes("--markdown")) {
        const { markdownDoctor } = await import("./doctor.js");
        process.stdout.write(markdownDoctor(checks));
      } else process.exitCode = printDoctor(checks);
      return;
    }
    case "config": {
      const { configPath, effectiveConfig, readConfig, template } = await import("./config.js");
      const file = configPath();
      if (rest[0] === "edit") {
        const fs = await import("node:fs");
        const path = await import("node:path");
        if (!fs.existsSync(file)) {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, template());
        }
        const { spawnSync } = await import("node:child_process");
        const editor = process.env.VISUAL || process.env.EDITOR || "vi";
        spawnSync("/bin/sh", ["-c", `${editor} "$1"`, "sh", file], { stdio: "inherit" });
        return;
      }
      const parsed = readConfig(file);
      process.stdout.write(`${file}${parsed.exists ? "" : " (not created yet: zdrop config edit)"}\n\n`);
      for (const { key, value, source } of effectiveConfig(parsed)) {
        process.stdout.write(`  ${key.key.padEnd(17)}${(value || "-").padEnd(12)}${source === "default" ? "\x1b[2mdefault\x1b[0m" : source === "env" ? `env ${key.env}` : "file"}\n`);
      }
      for (const problem of parsed.problems) process.stdout.write(`\x1b[33m!\x1b[0m ${problem}\n`);
      return;
    }
    case "forget": {
      const { LearnedStore } = await import("./learn/store.js");
      const store = new LearnedStore();
      if (rest[0] === "--all") await store.clear();
      else if (rest[0]) process.stdout.write(((await store.remove(rest[0])) ? "forgot " : "nothing learned for ") + rest[0] + "\n");
      else throw new Error("usage: zdrop forget <command>|--all");
      return;
    }
    case "learn-batch": {
      const { runBatch } = await import("./learn/worker.js");
      process.exitCode = await runBatch();
      return;
    }
    case "serve": {
      const { serve } = await import("./server.js");
      await serve();
      return;
    }
    case "status":
    case "stop": {
      const { request } = await import("./client.js");
      process.stdout.write((await request(command === "status" ? "S" : "X")) + "\n");
      return;
    }
    default:
      process.stderr.write(usage + "\n");
      process.exitCode = command == null || command === "help" ? 0 : 1;
  }
};

main(process.argv.slice(2)).catch((e) => {
  process.stderr.write(`zdrop: ${(e as Error).message}\n`);
  process.exitCode = 1;
});
