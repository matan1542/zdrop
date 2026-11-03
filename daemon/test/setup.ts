import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// every test file gets its own ZDROP_HOME, so learned specs never touch the real cache
process.env.ZDROP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "zdrop-home-"));
process.env.ZDROP_LEARN_BACKGROUND = "0";
// nor read the real ~/.config/zdrop/config
process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "zdrop-config-"));
