import { test } from "vitest";
import assert from "node:assert/strict";
import { continuationAllowed } from "./autoplay-continuation.mjs";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
for (const [saved, allowed] of [[null, true], ["0", false], ["1", true]]) {
  test(`runner continuation with saved preference ${saved}`, async () => {
    const run = src => new AsyncFunction("page", "localStorage", src)(
      { evaluate: fn => fn() }, { getItem: key => {
        assert.equal(key, "catanCopilot:continueAutoplay");
        return saved;
      } });
    assert.equal(await continuationAllowed(run), allowed);
  });
}
test("runner stops permitting new games as soon as the saved preference changes", async () => {
  let enabled = true;
  const run = async () => enabled;
  assert.equal(await continuationAllowed(run), true);
  enabled = false;
  assert.equal(await continuationAllowed(run), false);
});
test("runner cannot bypass an unreadable preference", async () => {
  await assert.rejects(continuationAllowed(async () => { throw new Error("driver unavailable"); }));
});
