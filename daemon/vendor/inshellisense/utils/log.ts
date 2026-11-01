// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// zdrop: logging is opt-in (ZDROP_DEBUG=1) and appends to ~/.cache/zdrop/daemon.log.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const logTarget = path.join(process.env.ZDROP_HOME ?? path.join(os.homedir(), ".cache", "zdrop"), "daemon.log");
const logEnabled = process.env.ZDROP_DEBUG === "1";

const debug = (content: object) => {
  if (!logEnabled) return;
  fs.appendFile(logTarget, JSON.stringify(content) + "\n", () => {});
};

export default { debug };
