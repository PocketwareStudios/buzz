import { expect, test } from "@playwright/test";

import { TEST_IDENTITIES, installMockBridge } from "../helpers/bridge";

type Page = import("@playwright/test").Page;

async function waitForMockLiveSubscription(page: Page, channelName: string) {
  await expect
    .poll(async () =>
      page.evaluate(
        ({ ch }) =>
          (
            window as Window & {
              __BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?: (input: {
                channelName: string;
              }) => boolean;
            }
          ).__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?.({ channelName: ch }) ??
          false,
        { ch: channelName },
      ),
    )
    .toBe(true);
}

// Messages are dated past the read frontier captured when the channel was last
// open (see unread-pill.spec.ts), one second apart so they sort in order.
async function emitMessages(
  page: Page,
  channelName: string,
  prefix: string,
  count: number,
  baseOffsetSeconds: number,
) {
  const base = Math.floor(Date.now() / 1000) + baseOffsetSeconds;
  for (let index = 1; index <= count; index += 1) {
    await page.evaluate(
      ({ ch, msg, pubkey, ts }) => {
        (
          window as Window & {
            __BUZZ_E2E_EMIT_MOCK_MESSAGE__?: (input: {
              channelName: string;
              content: string;
              pubkey: string;
              createdAt?: number;
            }) => unknown;
          }
        ).__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
          channelName: ch,
          content: msg,
          pubkey,
          createdAt: ts,
        });
      },
      {
        ch: channelName,
        msg: `${prefix} ${index}`,
        pubkey: TEST_IDENTITIES.alice.pubkey,
        ts: base + index,
      },
    );
  }
}

/** Whether a message row with this exact text is inside the timeline viewport. */
async function isInViewport(page: Page, text: string) {
  return page.evaluate((needle) => {
    const timeline = document.querySelector<HTMLElement>(
      '[data-testid="message-timeline"]',
    );
    if (!timeline) return false;
    const box = timeline.getBoundingClientRect();
    return [
      ...timeline.querySelectorAll<HTMLElement>("[data-message-id]"),
    ].some((row) => {
      // Rows also hold the time and quick-reaction emoji; match the body line.
      if (!row.innerText.split("\n").some((line) => line.trim() === needle))
        return false;
      const rect = row.getBoundingClientRect();
      return rect.bottom > box.top && rect.top < box.bottom;
    });
  }, text);
}

test.describe("resume reading position", () => {
  test("A — reaching held-back new posts keeps the first one in view", async ({
    page,
  }) => {
    await installMockBridge(page);
    await page.goto("/");
    await page.getByTestId("channel-general").click();
    await expect(page.getByTestId("chat-title")).toHaveText("general");
    await waitForMockLiveSubscription(page, "general");
    // The channel opens at its oldest unread post; go to the latest first.
    await page.getByTestId("message-timeline").hover();
    await page.mouse.wheel(0, 5000);
    await page.waitForTimeout(300);

    // Enough history to scroll, read while at the bottom.
    await emitMessages(page, "general", "History", 30, 5);
    await expect.poll(() => isInViewport(page, "History 30")).toBe(true);

    // Scroll up to read older posts, then new posts arrive below.
    const timeline = page.getByTestId("message-timeline");
    await timeline.hover();
    for (let i = 0; i < 8; i += 1) await page.mouse.wheel(0, -600);
    await page.waitForTimeout(300);
    await emitMessages(page, "general", "Fresh", 15, 120);
    await page.waitForTimeout(300);

    // Scroll down to the end of the history. The first arrival at the floor
    // is deliberately ignored (it can be synthetic), so a real trackpad's
    // momentum / rubber-band is what releases the held posts: emulate it with
    // a small nudge up and back down at the floor.
    for (let i = 0; i < 40; i += 1) {
      if (await isInViewport(page, "History 30")) break;
      await page.mouse.wheel(0, 250);
      await page.waitForTimeout(80);
    }
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(150);
    await page.mouse.wheel(0, -60);
    await page.waitForTimeout(150);
    await page.mouse.wheel(0, 200);
    await page.waitForTimeout(1000);

    // The reader keeps their place at the end of what they had read; the new
    // posts wait just below instead of the view jumping to the last one.
    expect(await isInViewport(page, "History 30")).toBe(true);
    expect(await isInViewport(page, "Fresh 15")).toBe(false);
    await expect(page.getByTestId("message-scroll-to-latest")).toBeVisible();

    // Reading on reaches the first new post.
    await page.mouse.wheel(0, 150);
    await expect.poll(() => isInViewport(page, "Fresh 1")).toBe(true);
  });

  test("B — opening a channel lands on the first unread post", async ({
    page,
  }) => {
    await installMockBridge(page);
    await page.goto("/");
    await page.getByTestId("channel-general").click();
    await expect(page.getByTestId("chat-title")).toHaveText("general");
    await waitForMockLiveSubscription(page, "general");
    await page.getByTestId("channel-random").click();
    await expect(page.getByTestId("chat-title")).toHaveText("random");

    await emitMessages(page, "general", "Unread", 30, 60);

    await page.getByTestId("channel-general").click();
    await expect(page.getByTestId("chat-title")).toHaveText("general");
    await page.waitForTimeout(800);

    expect(await isInViewport(page, "Unread 1")).toBe(true);
    expect(await isInViewport(page, "Unread 30")).toBe(false);
  });
  test("C — a channel with nothing unread still opens at the bottom", async ({
    page,
  }) => {
    await installMockBridge(page);
    await page.goto("/");
    await page.getByTestId("channel-general").click();
    await expect(page.getByTestId("chat-title")).toHaveText("general");
    await waitForMockLiveSubscription(page, "general");
    await page.getByTestId("message-timeline").hover();
    await page.mouse.wheel(0, 5000);
    await emitMessages(page, "general", "Seen", 30, 5);
    await expect.poll(() => isInViewport(page, "Seen 30")).toBe(true);

    await page.getByTestId("channel-random").click();
    await expect(page.getByTestId("chat-title")).toHaveText("random");
    await page.getByTestId("channel-general").click();
    await expect(page.getByTestId("chat-title")).toHaveText("general");
    await page.waitForTimeout(800);

    expect(await isInViewport(page, "Seen 30")).toBe(true);
  });

  test("D — unread posts that fit on screen still follow new posts", async ({
    page,
  }) => {
    await installMockBridge(page);
    await page.goto("/");
    await page.getByTestId("channel-general").click();
    await expect(page.getByTestId("chat-title")).toHaveText("general");
    await waitForMockLiveSubscription(page, "general");
    await page.getByTestId("channel-random").click();
    await expect(page.getByTestId("chat-title")).toHaveText("random");

    await emitMessages(page, "general", "Few", 2, 60);
    await page.getByTestId("channel-general").click();
    await expect(page.getByTestId("chat-title")).toHaveText("general");
    await page.waitForTimeout(800);
    expect(await isInViewport(page, "Few 1")).toBe(true);

    await emitMessages(page, "general", "Live", 25, 120);
    await expect.poll(() => isInViewport(page, "Live 25")).toBe(true);
  });
});
