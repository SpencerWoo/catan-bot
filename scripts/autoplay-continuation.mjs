/** The explicitly launched runner may start a first game with a legacy unset
 * preference. Once the extension initializes its default (0), every subsequent
 * queue request must honor it. Failures propagate rather than permitting a queue. */
export async function continuationAllowed(run) {
  return await run(`return await page.evaluate(() => localStorage.getItem("catanCopilot:continueAutoplay") !== "0");`) === true;
}
