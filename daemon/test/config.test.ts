import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyConfig, configKeys, effectiveConfig, parseConfig, readConfig, template } from "../src/config.js";
import { checkConfig } from "../src/doctor.js";
import { tempDir } from "./helpers.js";

describe("config file", () => {
  it("parses key = value lines, comments and quotes, and reports bad lines", () => {
    const parsed = parseConfig('# a comment\ntheme = light\naccent = #2969DA\nrows=10\nicons = "nerd"\nhistory = off\n\ncolour = red\nrows = many\ndocs\n');
    expect(Object.fromEntries(parsed.values)).toEqual({ theme: "light", accent: "#2969DA", rows: "10", icons: "nerd", history: "off" });
    expect(parsed.problems).toEqual([
      'line 8: unknown key "colour"',
      "line 9: rows = many: expected int",
      "line 10: docs = ?: expected side | below | off",
    ]);
  });

  it("lets the environment win over the file, and the file over defaults", () => {
    const parsed = parseConfig("theme = light\nhistory = off\nrows = 9\n");
    const effective = Object.fromEntries(effectiveConfig(parsed, { ZDROP_MAX_ROWS: "12" }).map((e) => [e.key.key, [e.value, e.source]]));
    expect(effective.theme).toEqual(["light", "file"]);
    expect(effective.rows).toEqual(["12", "env"]);
    expect(effective.history).toEqual(["off", "file"]);
    expect(effective.width).toEqual(["44", "default"]);
  });

  it("applies the daemon keys as ZDROP_* variables, never overriding one that is set", () => {
    const env: Record<string, string> = { ZDROP_TYPOS: "1" };
    applyConfig(parseConfig("history = off\ntypos = off\nlearn_deny = foo:bar\ntheme = light\n"), env);
    expect(env).toEqual({ ZDROP_HISTORY: "0", ZDROP_TYPOS: "1", ZDROP_LEARN_DENY: "foo:bar" });
  });

  it("writes a template that parses to nothing and documents every key", () => {
    const parsed = parseConfig(template());
    expect(parsed.values.size).toBe(0);
    expect(parsed.problems).toEqual([]);
    // each commented default is itself valid
    const uncommented = template().replace(/^# (\w+ = .*)$/gm, "$1");
    expect(parseConfig(uncommented).problems).toEqual([]);
    for (const key of configKeys) expect(template()).toContain(`# ${key.key} = `);
  });

  it("doctor reports a missing file, a valid one and a broken one", () => {
    const dir = tempDir("cfg");
    const file = path.join(dir, "config");
    expect(checkConfig(file)).toMatchObject({ level: "ok", detail: expect.stringMatching(/defaults/) });
    fs.writeFileSync(file, "theme = light\n");
    expect(checkConfig(file)).toMatchObject({ level: "ok", detail: expect.stringMatching(/^1 set/) });
    fs.writeFileSync(file, "them = light\n");
    expect(checkConfig(file)).toMatchObject({ level: "warn" });
    expect(readConfig(path.join(dir, "missing")).exists).toBe(false);
  });
});
