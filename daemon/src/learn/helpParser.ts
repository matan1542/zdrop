// Turns the text a CLI prints for `--help` (or a rendered man page) into a completion tree, with no
// knowledge of any particular tool. It recognises the layouts of the common argument libraries
// (commander, clap, cobra, yargs, click, argparse, GNU getopt, mdoc man pages) by their shape:
// section headings, an indented name column, a description column, and placeholder syntax.
// Heuristics follow zsh `_arguments --`, bash-completion `_comp_compgen_help` and fish
// `create_manpage_completions.py`; anything unrecognised is dropped rather than guessed.

/** Bumped whenever parsing changes, so cached results are re-parsed. */
export const PARSER_VERSION = 1;

export type HelpArg = {
  name: string;
  optional?: boolean;
  variadic?: boolean;
  choices?: string[];
  template?: "filepaths" | "folders";
};

export type HelpOption = { names: string[]; description: string; arg?: HelpArg };

export type HelpCommand = { names: string[]; description: string; args: HelpArg[]; options: HelpOption[] };

export type HelpNode = {
  description: string;
  subcommands: HelpCommand[];
  options: HelpOption[];
  args: HelpArg[];
};

type SectionKind = "commands" | "options" | "args" | "usage" | "skip" | "name" | "desc" | "other";

type Line = { indent: number; text: string };

const maxDescription = 100;

// eslint-disable-next-line no-control-regex
const ansi = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;

const normalize = (text: string): Line[] =>
  text
    .replace(ansi, "")
    .replace(/.\x08/g, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((raw) => {
      let line = "";
      for (const ch of raw) line += ch === "\t" ? " ".repeat(8 - (line.length % 8)) : ch;
      line = line.trimEnd();
      const indent = line.length - line.trimStart().length;
      return { indent, text: line.trimStart() };
    });

const classify = (heading: string): SectionKind => {
  const h = heading.toLowerCase().replace(/:$/, "");
  if (/^(usage|synopsis)\b/.test(h)) return "usage";
  if (h === "name") return "name";
  if (/^(description|about|summary|overview)$/.test(h)) return "desc";
  if (/example|see also|environment|exit status|^files$|bugs|history|standards|authors?|copyright|notes?|learn more|feedback|report|diagnostics|compatibility|caveats|return value/.test(h))
    return "skip";
  if (/option|flag|optional arguments|switches/.test(h)) return "options";
  if (/\b(sub)?commands?\b|\bactions?\b|\bverbs?\b/.test(h)) return "commands";
  if (/argument|positional|operand/.test(h)) return "args";
  return "other";
};

/** `Options:` / `FLAGS` / `positional arguments:` / `Usage: x [opts]` */
const headingOf = (line: Line, maxIndent: number): { kind: SectionKind; rest: string } | undefined => {
  if (line.indent > maxIndent || line.text.length === 0 || line.text.startsWith("-")) return;
  const usage = /^(usage|synopsis):?\s+(\S.*)$/i.exec(line.text);
  if (usage) return { kind: "usage", rest: usage[2] };
  if (/\s{2,}/.test(line.text)) return;
  if (line.text.endsWith(":") && line.text.length <= 60 && !line.text.includes("://")) return { kind: classify(line.text), rest: "" };
  if (/^[A-Z][A-Z0-9 _/&-]{1,40}$/.test(line.text)) return { kind: classify(line.text), rest: "" };
  return;
};

const isOptionStart = (text: string) => /^-{1,2}[A-Za-z0-9?@#[]/.test(text) && !/^-\s/.test(text);

/** Splits `name column    description` at the first gap of 2+ spaces. */
const splitColumns = (line: Line): { head: string; description: string; descCol?: number } => {
  const gap = /\s{2,}/.exec(line.text);
  if (gap == null) return { head: line.text, description: "" };
  return { head: line.text.slice(0, gap.index), description: line.text.slice(gap.index + gap[0].length), descCol: line.indent + gap.index + gap[0].length };
};

// ---------------------------------------------------------------------------------------------
// placeholders

const cobraTypes = new Set([
  "string", "strings", "stringarray", "stringslice", "stringtostring", "int", "ints", "int32", "int64", "uint", "uint8", "uint16",
  "uint32", "uint64", "float", "float32", "float64", "duration", "bytes", "ip", "ipmask", "ipnet", "list", "value", "num", "number",
  "path", "file", "dir", "text", "json", "count",
]);

const templateFor = (name: string): HelpArg["template"] => {
  const n = name.toLowerCase();
  if (/-or-|json|url|glob|pattern/.test(n)) return;
  if (/(^|[^a-z])(dirs?|director(y|ies)|folders?|cwd|root)([^a-z]|$)/.test(n)) return "folders";
  if (/(^|[^a-z])(files?|paths?|filenames?|filepaths?)([^a-z]|$)/.test(n) || /(file|path)$/.test(n)) return "filepaths";
  return;
};

const splitChoices = (raw: string, separator: RegExp): string[] =>
  raw
    .split(separator)
    .map((c) => c.trim().replace(/^["'`]|["'`]$/g, ""))
    .filter((c) => c.length > 0 && c.length <= 40 && !/\s/.test(c));

/** One placeholder token: `<name>`, `[name]`, `NAME`, `{a,b}`, `<a|b|c>`, `string`, `name...` */
const parsePlaceholder = (raw: string, forOption: boolean): HelpArg | undefined => {
  let token = raw.trim().replace(/^"(.*)"$/, "$1");
  if (token.length === 0) return;
  let optional = false;
  let variadic = false;
  if (/\.\.\.?\]?$|…$/.test(token)) {
    variadic = true;
    token = token.replace(/\.\.\.?(\])?$|…$/, "$1");
  }
  if (token.startsWith("[") && token.endsWith("]")) {
    optional = true;
    token = token.slice(1, -1).replace(/^=/, "");
  }
  if (/\.\.\.$/.test(token)) {
    variadic = true;
    token = token.slice(0, -3);
  }
  if (token.startsWith("<") && token.endsWith(">")) {
    token = token.slice(1, -1);
    if (token.endsWith("...")) {
      variadic = true;
      token = token.slice(0, -3);
    }
  } else if (token.startsWith("{") && token.endsWith("}")) {
    const choices = splitChoices(token.slice(1, -1), /,/);
    return choices.length > 0 ? { name: "value", optional, variadic, choices } : undefined;
  } else if (!forOption && !optional) {
    // a bare word after a command name is a placeholder only when it looks like one
    if (!/^[A-Z][A-Z0-9_-]*$/.test(token) && !/^"[^"]+"$/.test(raw.trim())) return;
  } else if (forOption && !optional && !/^[A-Z][A-Z0-9_.:-]*$/.test(token) && !/^[A-Z][a-z]+$/.test(token) && !cobraTypes.has(token.toLowerCase()) && !/^[a-z][a-z0-9_-]*$/.test(token)) {
    return;
  }
  token = token.replace(/^"|"$/g, "");
  if (token.length === 0 || token.length > 40) return;
  if (variadic && token.endsWith("...")) token = token.slice(0, -3);
  const arg: HelpArg = { name: token };
  if (optional) arg.optional = true;
  if (variadic) arg.variadic = true;
  // three or more literal alternatives are choices; `<id|name>` names two kinds of value instead
  const alternatives = token.split("|");
  if (alternatives.length >= 4 && alternatives.every((a) => /^[\w.:-]{1,12}$/.test(a))) {
    arg.choices = alternatives;
    arg.name = "value";
  }
  const template = templateFor(arg.name);
  if (template) arg.template = template;
  return arg;
};

// ---------------------------------------------------------------------------------------------
// descriptions

const annotation = /\s*[[(](?:default|defaults to|env|aliases?|possible values|choices|required|deprecated|number|boolean|string|array|count)\b[^\])]*[\])]/gi;

const firstSentence = (text: string): string => {
  let s = text.replace(annotation, "").replace(/\s+/g, " ").trim();
  // sentence end, not an abbreviation such as "e.g." or "etc."
  const end = /(?<!\b(?:e\.g|i\.e|etc|vs|approx|incl))[.!?](\s|$)(?=\s*[A-Z(`'"]|$)/.exec(s);
  if (end != null && end.index + 1 < s.length) s = s.slice(0, end.index + 1);
  s = s.replace(/\.$/, "");
  if (s.length > maxDescription) {
    const cut = s.lastIndexOf(" ", maxDescription - 1);
    s = s.slice(0, cut > 40 ? cut : maxDescription - 1) + "…";
  }
  return s;
};

const choicesFromText = (text: string): string[] | undefined => {
  const explicit = /[[(](?:possible values|choices|one of|allowed values)\s*:\s*([^\])]+)[\])]/i.exec(text);
  if (explicit) {
    const choices = splitChoices(explicit[1], /,\s*|\s+\|\s+/);
    if (choices.length > 0) return choices;
  }
  return;
};

/** `Effort level (low, medium, high, max)`: a parenthesised list of 3+ single lowercase words */
const listFromText = (text: string): string[] | undefined => {
  const match = /\(([a-z][\w-]{0,11}(?:,\s*(?:or\s+)?[a-z][\w-]{0,11}){2,})\)/.exec(text);
  return match ? splitChoices(match[1].replace(/\bor\s+/g, ""), /,\s*/) : undefined;
};

const aliasesFromText = (text: string): string[] => {
  const match = /[[(]aliases?\s*:\s*([^\])]+)[\])]/i.exec(text);
  return match ? splitChoices(match[1], /,\s*/) : [];
};

// ---------------------------------------------------------------------------------------------
// entries

type Block = {
  /** paragraph-joined text of the entry (all paragraphs, for choices/aliases) */
  all: string[];
  /** first paragraph only, for the visible description */
  first: string[];
  closedFirst: boolean;
  /** `- value: description` bullets (clap "Possible values:") */
  bullets: string[];
};

const newBlock = (inline: string): Block => ({ all: inline ? [inline] : [], first: inline ? [inline] : [], closedFirst: false, bullets: [] });

const addToBlock = (block: Block, text: string) => {
  const bullet = /^[-*•]\s+([\w.:-]+):?\s/.exec(text + " ");
  if (bullet) block.bullets.push(bullet[1].replace(/:$/, ""));
  block.all.push(text);
  if (!block.closedFirst && !/^(possible values|examples?):?$/i.test(text) && bullet == null) block.first.push(text);
};

type OptionEntry = { kind: "option"; option: HelpOption; block: Block; indent: number; descCol?: number };
type CommandEntry = { kind: "command"; command: HelpCommand; block: Block; indent: number; descCol?: number; nested?: OptionEntry };
type Entry = OptionEntry | CommandEntry;

const parseOptionHead = (head: string): { names: string[]; arg?: HelpArg } | undefined => {
  const names: string[] = [];
  let arg: HelpArg | undefined;
  // `-o, --output=FILE` / `--name string` / `-c, --continue` / `--x, -c` / `--[no-]color` / `-f FILE, --file FILE`
  // keep `{a,b}`, `<a b>` and `[x, y]` groups whole while splitting on spaces and commas
  const tokens = head.match(/\{[^}]*\}|<[^>]*>(?:\.\.\.)?|\[[^\]]*\](?:\.\.\.)?|[^\s,]+(?:\[[^\]]*\])?/g) ?? [];
  for (const token of tokens) {
    if (token === "," || token === "|" || token === "or") continue;
    if (/^-{1,2}[A-Za-z0-9?@#[]/.test(token)) {
      const eq = /^([^=[]+)(\[?=([^\]]*)\]?)$/.exec(token) ?? /^([^[]+)(\[=?([^\]]*)\])$/.exec(token);
      let name = eq ? eq[1] : token;
      if (eq && eq[3] && arg == null) arg = parsePlaceholder((eq[2].startsWith("[") ? "[" : "") + eq[3] + (eq[2].startsWith("[") ? "]" : ""), true);
      name = name.replace(/\.\.\.$/, "").replace(/[:;]$/, "");
      const negatable = /^(--?)\[(no-?|dont-?)\](.+)$/.exec(name);
      if (negatable) names.push(negatable[1] + negatable[3], negatable[1] + negatable[2] + negatable[3]);
      else if (/^-{1,2}[\w?@#][\w.:?@#-]*$/.test(name)) names.push(name);
      continue;
    }
    if (arg == null && names.length > 0) arg = parsePlaceholder(token, true);
  }
  return names.length > 0 ? { names: [...new Set(names)], arg } : undefined;
};

const ignoredCommandPlaceholders = /^[[<]?(options|flags|opts|command|commands|subcommand|cmd|global[-_ ]options)[\]>]?(\.\.\.)?$/i;

const parseCommandHead = (head: string, programPath: string[]): { names: string[]; args: HelpArg[] } | undefined => {
  let tokens = head.replace(/\s*,\s*/g, ", ").split(/\s+/).filter((t) => t.length > 0);
  // yargs prints the full path: `cli serve [port]`
  let p = 0;
  while (p < programPath.length && tokens.length > 1 && tokens[0] === programPath[p]) {
    tokens = tokens.slice(1);
    p++;
  }
  const names: string[] = [];
  let i = 0;
  for (; i < tokens.length; i++) {
    const token = tokens[i].replace(/,$/, "").replace(/\*$/, "");
    if (names.length > 0 && !tokens[i - 1].endsWith(",")) break;
    for (const name of token.split("|")) if (/^[A-Za-z0-9][\w:.+-]*$/.test(name) && !name.endsWith(":") && name.length <= 40) names.push(name);
    if (names.length === 0) return;
  }
  if (names.length === 0) return;
  const args: HelpArg[] = [];
  for (const token of tokens.slice(i)) {
    if (ignoredCommandPlaceholders.test(token) || token.startsWith("-") || token.startsWith("[-")) continue;
    const arg = parsePlaceholder(token, false);
    if (arg) args.push(arg);
  }
  return { names, args };
};

const finishOption = (entry: OptionEntry) => {
  const { option, block } = entry;
  option.description = firstSentence(block.first.join(" "));
  const all = block.all.join(" ");
  const choices = choicesFromText(all) ?? (block.bullets.length > 1 ? block.bullets : undefined) ?? (option.arg ? listFromText(option.description) : undefined);
  if (choices) {
    option.arg ??= { name: "value" };
    option.arg.choices ??= choices;
  }
  for (const alias of aliasesFromText(all)) if (alias.startsWith("-") && !option.names.includes(alias)) option.names.push(alias);
  // yargs marks value-taking options with their type: `-c, --config  Path to a config  [string]`
  const typed = /\[(string|number|array|count)\]/.exec(all);
  if (option.arg == null && typed && typed[1] !== "count") option.arg = typed[1] === "array" ? { name: "value", variadic: true } : { name: "value" };
};

const finishCommand = (entry: CommandEntry) => {
  if (entry.nested) finishOption(entry.nested);
  const all = entry.block.all.join(" ");
  entry.command.description = firstSentence(entry.block.first.join(" "));
  for (const alias of aliasesFromText(all)) if (!alias.startsWith("-") && !entry.command.names.includes(alias)) entry.command.names.push(alias);
};

// ---------------------------------------------------------------------------------------------

/**
 * @param text help or rendered man page text
 * @param programPath command words that printed it, e.g. ["claude", "mcp"] (stripped from yargs entries)
 */
export const parseHelp = (text: string, programPath: string[] = []): HelpNode => {
  const lines = normalize(text);
  const node: HelpNode = { description: "", subcommands: [], options: [], args: [] };
  const isMan = lines.some((l) => l.indent === 0 && /^(NAME|SYNOPSIS)$/.test(l.text));

  let kind: SectionKind = "other";
  let sectionIndent: number | undefined;
  let entry: Entry | undefined;
  const preamble: string[] = [];
  let preambleDone = false;
  const usageLines: string[] = [];

  const optionNames = new Set<string>();
  const commandNames = new Set<string>();

  const closeEntry = () => {
    if (entry == null) return;
    if (entry.kind === "option") {
      finishOption(entry);
      if (!entry.option.names.some((n) => optionNames.has(n))) {
        entry.option.names.forEach((n) => optionNames.add(n));
        node.options.push(entry.option);
      }
    } else {
      finishCommand(entry);
      if (!commandNames.has(entry.command.names[0])) {
        entry.command.names.forEach((n) => commandNames.add(n));
        node.subcommands.push(entry.command);
      }
    }
    entry = undefined;
  };

  const startOption = (line: Line): OptionEntry | undefined => {
    const { head, description, descCol } = splitColumns(line);
    const parsed = parseOptionHead(head);
    if (parsed == null) return;
    return { kind: "option", option: { names: parsed.names, description: "", arg: parsed.arg }, block: newBlock(description), indent: line.indent, descCol };
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.text.length === 0) {
      if (entry) {
        entry.block.closedFirst = entry.block.first.length > 0;
        if (entry.kind === "command" && entry.nested) entry.nested.block.closedFirst = entry.nested.block.first.length > 0;
      }
      if (preamble.length > 0) preambleDone = true;
      // the usage block ends at a blank line; the tool's one-line summary often follows it
      if (kind === "usage" && usageLines.length > 0) kind = "other";
      continue;
    }

    // a heading must sit left of the current section's entries (`  Examples:` inside a description is not one)
    const heading = headingOf(line, sectionIndent != null ? Math.min(2, sectionIndent - 1) : 2);
    if (heading) {
      closeEntry();
      kind = heading.kind;
      sectionIndent = undefined;
      if (preamble.length > 0) preambleDone = true;
      if (kind === "usage" && heading.rest) usageLines.push(heading.rest);
      continue;
    }

    if (kind === "name") {
      if (!node.description) node.description = firstSentence(line.text.replace(/^.*?\s+[-–—]\s+/, ""));
      continue;
    }
    if (kind === "usage") {
      usageLines.push(line.text);
      continue;
    }
    if (kind === "skip") continue;

    // continuation of the current entry
    if (entry && line.indent > entry.indent) {
      const optionLike = isOptionStart(line.text);
      if (entry.kind === "command") {
        const nested = entry.nested;
        if (optionLike && (entry.descCol == null || line.indent < entry.descCol) && (nested == null || line.indent <= nested.indent || nested.descCol == null || line.indent < nested.descCol)) {
          if (nested) finishOption(nested);
          const option = startOption(line);
          if (option) {
            if (nested && !entry.command.options.some((o) => o.names[0] === nested.option.names[0])) entry.command.options.push(nested.option);
            entry.nested = option;
            if (!entry.command.options.includes(option.option)) entry.command.options.push(option.option);
            continue;
          }
        }
        if (nested && line.indent > nested.indent) {
          if (nested.descCol == null && !optionLike) nested.descCol = line.indent;
          if (line.indent >= (nested.descCol ?? 0)) addToBlock(nested.block, line.text);
          continue;
        }
        if (entry.descCol == null) entry.descCol = line.indent;
        if (line.indent >= entry.descCol && entry.nested == null) addToBlock(entry.block, line.text);
        continue;
      }
      // option entry: a deeper option line left of the description column starts the next entry (clap)
      if (!(optionLike && (entry.descCol == null || line.indent < entry.descCol))) {
        if (entry.descCol == null) entry.descCol = line.indent;
        if (line.indent >= entry.descCol) addToBlock(entry.block, line.text);
        continue;
      }
    }

    if (isOptionStart(line.text) && line.indent >= 1 && kind !== "commands") {
      closeEntry();
      const option = startOption(line);
      if (option) {
        entry = option;
        sectionIndent ??= line.indent;
      }
      continue;
    }

    if (kind === "commands" && !isMan) {
      const { head, description, descCol } = splitColumns(line);
      const parsed = line.indent >= 1 ? parseCommandHead(head, programPath) : undefined;
      if (parsed && (sectionIndent == null || line.indent <= sectionIndent + 1)) {
        closeEntry();
        entry = {
          kind: "command",
          command: { names: parsed.names, description: "", args: parsed.args, options: [] },
          block: newBlock(description),
          indent: line.indent,
          descCol,
        };
        sectionIndent ??= line.indent;
      } else if (entry) {
        // `  Examples:` and other text at the entry column ends the description paragraph
        entry.block.closedFirst = true;
      }
      continue;
    }

    if (kind === "args" && !isMan) {
      const { head, description, descCol } = splitColumns(line);
      closeEntry();
      // argparse lists subcommands as `{a,b,c}` with each one described underneath
      const braces = /^\{([^}]+)\}$/.exec(head);
      if (braces) {
        for (const name of splitChoices(braces[1], /,/)) {
          if (!commandNames.has(name)) {
            commandNames.add(name);
            node.subcommands.push({ names: [name], description: "", args: [], options: [] });
          }
        }
        continue;
      }
      const sub = node.subcommands.find((c) => c.names[0] === head && c.description === "");
      if (sub && description) {
        sub.description = firstSentence(description);
        continue;
      }
      const arg = parsePlaceholder(/^[\w-]+$/.test(head) && !/^[A-Z]/.test(head) ? `<${head}>` : head, false);
      if (arg && line.indent >= 1 && node.args.length < 8) {
        node.args.push(arg);
        const nextChoices = choicesFromText(description);
        if (nextChoices) arg.choices = nextChoices;
        sectionIndent ??= line.indent;
        void descCol;
      }
      continue;
    }

    if ((kind === "other" || kind === "desc") && entry == null && !preambleDone && line.indent <= 4 && !/^(warning|error|note|deprecated|info)\b|\b(error|failed to|could not|cannot|unable to)\b/i.test(line.text)) {
      preamble.push(line.text);
    }
  }
  closeEntry();

  if (!node.description) {
    const prog = programPath[0];
    const summary = preamble.filter((l) => !/^[\w./-]+ v?\d+(\.\d+)+\S*$/.test(l) && !(prog && (l === prog || (l.startsWith(`${prog} `) && /[<[{]/.test(l)))));
    node.description = firstSentence(summary.join(" "));
  }

  // git-style listings without a commands heading: `   add        Add file contents to the index`
  if (node.subcommands.length === 0 && !isMan) {
    for (const line of lines) {
      const match = /^([a-z][\w-]*)\s{3,}([A-Z].*)$/.exec(line.text);
      if (match && line.indent >= 2 && line.indent <= 4 && !commandNames.has(match[1])) {
        commandNames.add(match[1]);
        node.subcommands.push({ names: [match[1]], description: firstSentence(match[2]), args: [], options: [] });
      }
    }
  }

  // `prog sub [--flag] <arg>` lines (usage blocks, yarn/corepack-style listings) name subcommands too
  if (node.subcommands.length === 0 && !isMan && programPath.length > 0) {
    const prog = programPath.at(-1)!;
    for (let i = 0; i < lines.length; i++) {
      const tokens = lines[i].text.replace(/^\$\s+/, "").split(/\s+/);
      const at = tokens.findIndex((t) => t === prog || t.endsWith(`/${prog}`));
      if (at !== 0 || tokens.length < 2 || !/^[a-z][\w:-]*$/.test(tokens[1]) || commandNames.has(tokens[1])) continue;
      const options: HelpOption[] = [];
      for (const match of lines[i].text.matchAll(/\[(--?[\w-]+)(?:[ =]<?([\w-]+)>?)?(?:\|--?[\w-]+)*\]/g)) {
        options.push({ names: [match[1]], description: "", arg: match[2] ? { name: match[2] } : undefined });
      }
      const next = lines[i + 1];
      const description = next && next.indent > lines[i].indent && !next.text.startsWith(prog) ? firstSentence(next.text) : "";
      commandNames.add(tokens[1]);
      node.subcommands.push({ names: [tokens[1]], description, args: [], options });
    }
  }

  // positional arguments from the usage line when there is no Arguments section
  if (node.args.length === 0 && !isMan && programPath.length > 0) {
    const usage = usageLines.find((u) => u.split(/\s+/)[0]?.endsWith(programPath[0])) ?? "";
    const tokens = usage.split(/\s+/).slice(1);
    let p = 1;
    while (p < programPath.length && tokens[0] === programPath[p]) {
      tokens.shift();
      p++;
    }
    for (const token of tokens) {
      if (ignoredCommandPlaceholders.test(token) || /^\[?-/.test(token) || token === "|") continue;
      if (!/^[[<]/.test(token)) continue;
      const arg = parsePlaceholder(token, false);
      if (arg && node.args.length < 4) node.args.push(arg);
    }
  }

  return node;
};

/** True when the text parsed into something worth offering. */
export const looksLikeHelp = (node: HelpNode): boolean => node.subcommands.length > 0 || node.options.length >= 2;
