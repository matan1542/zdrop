import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkEditors, checkTerminal, checkZshrc, markdownDoctor } from "../src/doctor.js";
import { latestRelease, newer, noticeFor } from "../src/update.js";
import { tempDir } from "./helpers.js";

const zshrc = (text: string) => {
  const file = path.join(tempDir("zshrc"), ".zshrc");
  fs.writeFileSync(file, text);
  return file;
};
const levels = (checks: { level: string; title: string }[]) => Object.fromEntries(checks.map((c) => [c.title, c.level]));

describe("doctor", () => {
  it("accepts one zdrop line loaded last", () => {
    const home = tempDir("home");
    fs.mkdirSync(path.join(home, ".zdrop", "current", "zsh"), { recursive: true });
    fs.writeFileSync(path.join(home, ".zdrop", "current", "zsh", "zdrop.plugin.zsh"), "");
    expect(levels(checkZshrc(zshrc('source ~/.oh-my-zsh/oh-my-zsh.sh\nbindkey -e\nsource "$HOME/.zdrop/current/zsh/zdrop.plugin.zsh"\nalias g=git\n'), home))).toEqual({
      "~/.zshrc loads zdrop once": "ok",
      "zdrop loads last": "ok",
    });
  });

  it("flags a missing line, duplicates, plugins loaded after it and rival popups", () => {
    expect(checkZshrc(zshrc("PS1='$ '\n"))[0]).toMatchObject({ level: "fail", title: "~/.zshrc loads zdrop", detail: expect.stringMatching(/zdrop setup/) });
    const checks = checkZshrc(zshrc("source a/zdrop.plugin.zsh\nsource b/zdrop.plugin.zsh\nsource ~/zsh-autosuggestions/zsh-autosuggestions.zsh\neval \"$(kiro-cli init zsh post)\"\n"));
    expect(levels(checks)).toEqual({ "~/.zshrc loads zdrop once": "fail", "zdrop loads last": "warn", "no other autocomplete popup": "warn" });
    expect(checks.find((c) => c.title === "zdrop loads last")?.detail).toMatch(/3: source ~\/zsh-autosuggestions/);
  });

  it("prints a markdown block for an issue, with the home folder hidden", () => {
    const text = markdownDoctor([{ level: "warn", title: "settings", detail: "/Users/someone/.config/zdrop/config: bad" }], "/Users/someone");
    expect(text).toContain("! settings  ~/.config/zdrop/config: bad");
    expect(text).not.toContain("/Users/someone");
    expect(text).toMatch(/^<details>/);
  });

  it("flags a line that sources a file that is gone", () => {
    const home = tempDir("home");
    fs.mkdirSync(path.join(home, "zdrop", "zsh"), { recursive: true });
    fs.writeFileSync(path.join(home, "zdrop", "zsh", "zdrop.plugin.zsh"), "");
    expect(levels(checkZshrc(zshrc('source "$HOME/zdrop/zsh/zdrop.plugin.zsh"\n'), home))["~/.zshrc loads zdrop"]).toBeUndefined();
    expect(levels(checkZshrc(zshrc("source ~/gone/zsh/zdrop.plugin.zsh\n"), home))["~/.zshrc loads zdrop"]).toBe("fail");
    // unresolvable without running the shell: not judged
    expect(levels(checkZshrc(zshrc('source "$(brew --prefix)/opt/zdrop/libexec/zsh/zdrop.plugin.zsh"\n'), home))["~/.zshrc loads zdrop"]).toBeUndefined();
  });

  it("checks IDE terminal suggestions, reading settings with comments", () => {
    const home = tempDir("home");
    const settings = (dir: string, text: string) => {
      const file = path.join(home, "Library", "Application Support", dir, "User", "settings.json");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    };
    settings("Code", '{\n  // mine\n  "terminal.integrated.suggest.enabled": false,\n}');
    settings("Cursor", '{ "editor.fontSize": 13 }');
    expect(levels(checkEditors(home, "darwin"))).toEqual({ "VS Code terminal suggestions off": "ok", "Cursor terminal suggestions off": "warn" });
  });

  it("finds editor settings in ~/.config on Linux", () => {
    const home = tempDir("home");
    const file = path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "Kiro", "User", "settings.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ "terminal.integrated.suggest.enabled": false }');
    expect(levels(checkEditors(home, "linux"))).toMatchObject({ "Kiro terminal suggestions off": "ok" });
  });

  it("knows which terminals draw without flicker", () => {
    expect(checkTerminal("Apple_Terminal").level).toBe("warn");
    expect(checkTerminal("iTerm.app").level).toBe("ok");
  });
});

describe("update check", () => {
  it("compares versions", () => {
    expect(newer("0.10.0", "0.9.9")).toBe(true);
    expect(newer("0.2.0", "0.2.0")).toBe(false);
    expect(newer("v1.0.0", "0.9.0")).toBe(true);
    expect(noticeFor("0.1.0", "0.2.0", false)).toBe("zdrop 0.2.0 available · zdrop update");
    expect(noticeFor("0.1.0", "0.2.0", true)).toBe("zdrop 0.2.0 available · brew upgrade zdrop");
    expect(noticeFor("0.2.0", "0.2.0", false)).toBe("");
  });

  it("asks GitHub at most once a week", async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls++;
      return new Response(JSON.stringify({ tag_name: "v0.3.0" }), { status: 200 });
    }) as typeof fetch;
    const now = Date.now() + 365 * 86_400_000; // past any cached check
    expect(await latestRelease(fetcher, now)).toBe("0.3.0");
    expect(await latestRelease(fetcher, now + 86_400_000)).toBe("0.3.0");
    expect(calls).toBe(1);
    expect(await latestRelease(fetcher, now + 8 * 86_400_000)).toBe("0.3.0");
    expect(calls).toBe(2);
  });
});
