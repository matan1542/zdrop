import path from "node:path";
import { fileURLToPath } from "node:url";
import { setSpecProvider } from "../vendor/inshellisense/runtime/runtime.js";
import { SpecLoader, stockSpecDir } from "./specLoader.js";
import { learnConfig } from "./learn/config.js";
import { Learner } from "./learn/learner.js";

/** Repository root (this file lives in dist/src/ after the build). */
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Spec directories, highest priority first: $ZDROP_SPEC_PATH (colon-separated), then this repo's
 * specs/build, then the stock Fig specs. A spec in an earlier directory overrides one with the same name.
 */
export const specDirs = (): string[] => [
  ...(process.env.ZDROP_SPEC_PATH ?? "").split(":").filter((dir) => dir.length > 0),
  path.join(repoRoot, "specs", "build"),
  stockSpecDir(),
];

export type Runtime = { loader: SpecLoader; learner?: Learner };

/** Spec loading for the daemon and the CLI; commands with no Fig spec are learned unless ZDROP_LEARN=0. */
export const initRuntime = (): Runtime => {
  const loader = new SpecLoader(specDirs());
  setSpecProvider(loader);
  if (!learnConfig.enabled) return { loader };
  const learner = new Learner({ hasFigSpec: (name) => loader.hasSpec(name) });
  loader.setLearner(learner);
  return { loader, learner };
};
