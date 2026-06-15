import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";

import * as functions from "./index.js";

test("exports exactly the canonical first-party function manifest", () => {
  const expectedFunctions = JSON.parse(
    readFileSync("../function-manifest.json", "utf8"),
  ) as string[];
  assert.deepEqual(Object.keys(functions).sort(), expectedFunctions.sort());
});
