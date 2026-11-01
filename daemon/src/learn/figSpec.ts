import type { HelpArg, HelpCommand, HelpNode, HelpOption } from "./helpParser.js";
import { nativeGenerator, type Protocol } from "./native.js";

/** Learned help for one command: "" is the root, "mcp" and "mcp/add" are subcommands. */
export type HelpTree = Record<string, HelpNode>;

/** The program's own completion protocol, used for argument values the help text can't list. */
export type Native = { protocol: Protocol; file: string; base: string; generator?: Fig.Generator };

const toArg = (arg: HelpArg, native?: Native): Fig.Arg => {
  const fig: Fig.Arg = { name: arg.name };
  if (arg.optional) fig.isOptional = true;
  if (arg.variadic) fig.isVariadic = true;
  if (arg.choices) fig.suggestions = arg.choices;
  if (arg.template) fig.template = arg.template;
  else if (native && !arg.choices) fig.generators = generatorOf(native);
  return fig;
};

const generatorOf = (native: Native): Fig.Generator => (native.generator ??= nativeGenerator(native.protocol, native.file, native.base));

const toOption = (option: HelpOption, native?: Native): Fig.Option => {
  const fig: Fig.Option = { name: option.names.length === 1 ? option.names[0] : option.names };
  if (option.description) fig.description = option.description;
  if (option.arg) fig.args = toArg(option.arg, native);
  return fig;
};

const nameOf = (names: string[]): Fig.SingleOrArray<string> => (names.length === 1 ? names[0] : names);

/**
 * Builds the Fig spec for `path` (a subcommand path within `command`, "" for the root). Subcommands
 * already learned are embedded; the rest carry `loadSpec: "<command>/<path>"` so the runtime asks for
 * them (and we run their `--help`) only when the user reaches them.
 */
export const toFigSpec = (command: string, tree: HelpTree, path = "", listed?: HelpCommand, native?: Native): Fig.Subcommand => {
  const node = tree[path];
  const spec: Fig.Subcommand = { name: listed ? nameOf(listed.names) : command };
  const description = node?.description || listed?.description;
  if (description) spec.description = description;

  const subcommands = (node?.subcommands ?? []).map((child) => {
    const childPath = path ? `${path}/${child.names[0]}` : child.names[0];
    if (tree[childPath] != null) return toFigSpec(command, tree, childPath, child, native);
    const lazy: Fig.Subcommand = { name: nameOf(child.names), loadSpec: `${command}/${childPath}` };
    if (child.description) lazy.description = child.description;
    if (child.options.length > 0) lazy.options = child.options.map((o) => toOption(o, native));
    if (child.args.length > 0) lazy.args = child.args.map((a) => toArg(a, native));
    return lazy;
  });
  if (subcommands.length > 0) spec.subcommands = subcommands;

  // a subcommand's own --help is authoritative; what its parent listed is the fallback
  const options = node?.options.length ? node.options : (listed?.options ?? []);
  if (options.length > 0) spec.options = options.map((o) => toOption(o, native));
  const args = node?.args.length ? node.args : (listed?.args ?? []);
  if (args.length > 0) spec.args = args.map((a) => toArg(a, native));
  // a leaf whose help names no arguments can still take some: let the program say which
  else if (native && subcommands.length === 0 && node != null) spec.args = { name: "args", isOptional: true, isVariadic: true, generators: generatorOf(native) };
  return spec;
};
