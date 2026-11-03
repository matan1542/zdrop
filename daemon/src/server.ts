import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import log from "../vendor/inshellisense/utils/log.js";
import { ShellNames, shellNames } from "../vendor/inshellisense/runtime/alias.js";
import { clearImplicitGeneratorState, getGeneratorCacheStats } from "../vendor/inshellisense/runtime/generatorCache.js";
import { runQuery } from "./engine.js";
import { childSlots, killAllChildren, limits, liveChildren } from "./limits.js";
import { encodeProgress, encodeResult, pidPath, socketPath, US, zdropHome } from "./protocol.js";
import { initRuntime } from "./setup.js";
import { BackgroundBuilder } from "./learn/builder.js";
import { learnConfig } from "./learn/config.js";
import { requestEnv, type ShellEnv } from "./learn/context.js";
import { dirs } from "./rank/dirs.js";
import { startUpdateCheck, updateNotice } from "./update.js";
import { usage } from "./rank/usage.js";

const progressIntervalMs = 100;

type Session = {
  controller?: AbortController;
  progress?: NodeJS.Timeout;
  prefetch?: NodeJS.Timeout;
  env?: ShellEnv;
  /** this shell's aliases, functions, builtins and options */
  names: ShellNames;
};

const mb = (bytes: number) => +(bytes / 1048576).toFixed(1);

const isAbort = (e: unknown) => e instanceof Error && e.name === "AbortError";

/** Another daemon already answers on the socket. */
const alreadyRunning = (): Promise<boolean> =>
  new Promise((resolve) => {
    const probe = net.connect(socketPath);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });

/** Keeps a log under 1 MB: the previous one is kept as `.1`. */
const rotate = (file: string) => {
  try {
    if (fs.statSync(file).size > 1024 * 1024) fs.renameSync(file, file + ".1");
  } catch {
    // no log yet
  }
};

export const serve = async (): Promise<void> => {
  fs.mkdirSync(zdropHome, { recursive: true, mode: 0o700 });
  rotate(path.join(zdropHome, "daemon.log"));
  if (await alreadyRunning()) {
    log.debug({ msg: "daemon already running" });
    return;
  }
  fs.rmSync(socketPath, { force: true });

  const { loader, learner } = initRuntime();
  if (learner != null) {
    await learner.store.loadIndex();
    await learner.store.compact().catch(() => undefined);
  }
  const builder = new BackgroundBuilder(() => {
    void learner?.store.loadIndex().then(() => learner.changed(learner.store.descriptions.keys()));
  });
  const sessions = new Set<net.Socket>();
  const startedAt = Date.now();
  let idleTimer: NodeJS.Timeout | undefined;

  const shutdown = (reason: string, code = 0) => {
    log.debug({ msg: "shutting down", reason });
    // `zdrop doctor` and `status` report why the daemon last went away
    try {
      fs.writeFileSync(
        path.join(zdropHome, "last-exit.json"),
        JSON.stringify({ reason, at: new Date().toISOString(), pid: process.pid, rssMB: mb(process.memoryUsage().rss), uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) }),
      );
    } catch {
      // best effort
    }
    builder.stop();
    dirs.flush();
    killAllChildren();
    learner?.dispose();
    server.close();
    for (const socket of sessions) socket.destroy();
    fs.rmSync(socketPath, { force: true });
    fs.rmSync(pidPath, { force: true });
    process.exit(code);
  };

  const armIdleTimer = () => {
    clearTimeout(idleTimer);
    if (sessions.size === 0 && limits.idleExitMs > 0) idleTimer = setTimeout(() => shutdown("idle"), limits.idleExitMs).unref();
  };

  const stats = () => {
    const memory = process.memoryUsage();
    return {
      pid: process.pid,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      sessions: sessions.size,
      memory: { rssMB: mb(memory.rss), heapUsedMB: mb(memory.heapUsed), rssLimitMB: mb(limits.rssLimitBytes) },
      specs: loader.stats(),
      generatorCache: { ...getGeneratorCacheStats(), budget: limits.generatorCacheSuggestions },
      children: { running: liveChildren.size, slotsInUse: childSlots.inUse, queued: childSlots.queued, max: limits.maxConcurrentChildren },
      learn: learner == null ? { enabled: false } : { ...learner.stats(), background: builder.stats() },
      usage: usage.stats(),
      dirs: dirs.stats(),
    };
  };

  const handleQuery = (socket: net.Socket, session: Session, seq: string, cwd: string, lbuffer: string) => {
    session.controller?.abort();
    clearInterval(session.progress);
    clearTimeout(session.prefetch);
    const controller = new AbortController();
    session.controller = controller;
    const { signal } = controller;
    const env: ShellEnv = { ...(session.env ?? { path: process.env.PATH ?? "/usr/bin:/bin" }), cwd };
    builder.onQuery();
    if (learner != null) {
      // once typing pauses, learn what the user is most likely about to need
      session.prefetch = setTimeout(() => shellNames.run(session.names, () => requestEnv.run(env, () => learner.prefetch(lbuffer))), learnConfig.prefetchDebounceMs);
      session.prefetch.unref();
    }

    void shellNames.run(session.names, () => requestEnv.run(env, () => runQuery(
      lbuffer,
      cwd,
      (result) => {
        if (signal.aborted || socket.destroyed) return;
        clearInterval(session.progress);
        socket.write(encodeResult(seq, result, updateNotice));
        if (result.pending.length > 0) {
          const label = result.pending.join(", ");
          session.progress = setInterval(() => {
            if (signal.aborted || socket.destroyed) clearInterval(session.progress);
            else socket.write(encodeProgress(seq, label));
          }, progressIntervalMs);
        }
      },
      signal,
    )))
      .catch((e) => {
        if (!isAbort(e)) log.debug({ msg: "query failed", e: (e as Error).message, lbuffer });
      })
      .finally(() => {
        if (session.controller === controller) clearInterval(session.progress);
      });
  };

  const handleLine = (socket: net.Socket, session: Session, line: string) => {
    const [kind, ...fields] = line.split(US);
    switch (kind) {
      case "Q":
        handleQuery(socket, session, fields[0] ?? "0", fields[1] || process.env.HOME || "/", fields.slice(2).join(US));
        break;
      case "A": {
        const aliases: Record<string, string> = {};
        for (let i = 0; i + 1 < fields.length; i += 2) aliases[fields[i]] = fields[i + 1];
        session.names.setAliases(aliases);
        break;
      }
      case "F": {
        // flags, function names, "", builtin and reserved-word names
        const split = fields.indexOf("", 1);
        const functions = fields.slice(1, split === -1 ? undefined : split);
        session.names.setFunctions(functions, split === -1 ? [] : fields.slice(split + 1), (fields[0] ?? "").includes("c"));
        break;
      }
      case "E": {
        session.env = { path: fields[0] || process.env.PATH || "/usr/bin:/bin", histfile: fields[1] || undefined };
        builder.setEnv(session.env);
        void shellNames.run(session.names, () => usage.loadHistory(session.env?.histfile)).catch(() => undefined);
        break;
      }
      case "H":
        shellNames.run(session.names, () => usage.record(fields.join(US)));
        break;
      case "D":
        if (fields[0]) dirs.visit(fields[0]);
        break;
      case "N":
        clearImplicitGeneratorState();
        break;
      case "S":
        socket.write(JSON.stringify(stats()) + "\n");
        break;
      case "X":
        socket.end("stopping\n", () => shutdown("stop requested"));
        break;
    }
  };

  const server = net.createServer((socket) => {
    const session: Session = { names: new ShellNames() };
    sessions.add(socket);
    armIdleTimer();
    let buffered = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      // a client never needs more than a command line per message; drop anything absurd
      if (buffered.length > 256 * 1024) buffered = "";
      let newline: number;
      while ((newline = buffered.indexOf("\n")) !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line.length > 0) handleLine(socket, session, line);
      }
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      session.controller?.abort();
      clearInterval(session.progress);
      clearTimeout(session.prefetch);
      sessions.delete(socket);
      armIdleTimer();
    });
  });

  // A rebuilt or reinstalled zdrop must not keep answering with old code from a long-lived daemon:
  // once our own files are newer than this process, exit; the next keystroke starts the new code.
  const ownCode = fileURLToPath(import.meta.url);
  setInterval(() => {
    try {
      if (fs.statSync(ownCode).mtimeMs > startedAt) shutdown("code updated");
    } catch {
      shutdown("code removed");
    }
  }, 10_000).unref();

  // Restarting is the only way to hand memory back from V8; the plugin respawns us on its next keystroke.
  setInterval(() => {
    if (process.memoryUsage().rss > limits.rssLimitBytes) shutdown("rss limit");
  }, limits.rssCheckIntervalMs).unref();

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGHUP", () => {}); // survive the terminal that started us closing
  // a bug must not leave a half-working daemon: record it and exit; the next keystroke starts a fresh one
  process.on("uncaughtException", (e) => shutdown(`crash: ${e.message}`, 1));
  process.on("unhandledRejection", (e) => shutdown(`crash: ${e instanceof Error ? e.message : String(e)}`, 1));

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      fs.chmodSync(socketPath, 0o600);
      fs.writeFileSync(pidPath, String(process.pid));
      armIdleTimer();
      log.debug({ msg: "listening", socketPath, pid: process.pid });
      if (learner != null) builder.start();
      // started at login by `zdrop setup`'s launch agent: learn from the PATH it was given, before any shell connects
      if (process.env.ZDROP_LOGIN === "1" && process.env.PATH) builder.setEnv({ path: process.env.PATH, histfile: process.env.HISTFILE || undefined });
      startUpdateCheck();
      resolve();
    });
  });
};
