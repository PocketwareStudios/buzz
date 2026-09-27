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

/** The body text of the message row nearest the middle of the viewport. */
async function middleVisiblePost(page: Page, prefix: string) {
  return page.evaluate((prefix) => {
    const timeline = document.querySelector<HTMLElement>(
      '[data-testid="message-timeline"]',
    );
    if (!timeline) return null;
    const box = timeline.getBoundingClientRect();
    const middle = (box.top + box.bottom) / 2;
    let best: { text: string; distance: number } | null = null;
    for (const row of timeline.querySelectorAll<HTMLElement>(
      "[data-message-id]",
    )) {
      const text = row.innerText
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.startsWith(prefix));
      if (!text) continue;
      const rect = row.getBoundingClientRect();
      const distance = Math.abs((rect.top + rect.bottom) / 2 - middle);
      if (!best || distance < best.distance) best = { text, distance };
    }
    return best?.text ?? null;
  }, prefix);
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
    // Catch up to the bottom before leaving, so there is no position to
    // return to: new posts then open at the first unread one.
    await page.getByTestId("message-timeline").hover();
    await page.mouse.wheel(0, 5000);
    await page.waitForTimeout(300);
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
  for (const [label, simulate] of [
    ["nothing (control)", async (_page: Page) => {}],
    [
      "the window losing and regaining focus",
      async (page: Page) => {
        await page.evaluate(() => {
          const set = (state: string) =>
            Object.defineProperty(document, "visibilityState", {
              configurable: true,
              get: () => state,
            });
          set("hidden");
          document.dispatchEvent(new Event("visibilitychange"));
          window.dispatchEvent(new Event("blur"));
          set("visible");
          document.dispatchEvent(new Event("visibilitychange"));
          window.dispatchEvent(new Event("focus"));
        });
      },
    ],
    [
      "a relay reconnect (e.g. after sleep)",
      async (page: Page) => {
        await page.evaluate(() =>
          (
            window as Window & {
              __BUZZ_E2E_RESTART_MOCK_WEBSOCKETS__?: () => number;
            }
          ).__BUZZ_E2E_RESTART_MOCK_WEBSOCKETS__?.(),
        );
      },
    ],
  ] as const) {
    test(`E — returning to the app keeps the reading position: ${label}`, async ({
      page,
    }) => {
      await installMockBridge(page);
      await page.goto("/");
      await page.getByTestId("channel-general").click();
      await expect(page.getByTestId("chat-title")).toHaveText("general");
      await waitForMockLiveSubscription(page, "general");
      const timeline = page.getByTestId("message-timeline");
      await timeline.hover();
      await page.mouse.wheel(0, 5000);
      await emitMessages(page, "general", "Post", 60, 5);
      await expect.poll(() => isInViewport(page, "Post 60")).toBe(true);

      // Read somewhere in the middle, and note the post under the reader.
      // Stay well inside the loaded posts, away from the history loader.
      for (let i = 0; i < 2; i += 1) await page.mouse.wheel(0, -400);
      await page.waitForTimeout(500);
      const reading = await middleVisiblePost(page, "Post ");
      expect(reading).not.toBeNull();
      expect(await isInViewport(page, "Post 60")).toBe(false);

      await simulate(page);
      await page.waitForTimeout(2000);

      expect(await isInViewport(page, reading as string)).toBe(true);
      expect(await isInViewport(page, "Post 60")).toBe(false);
    });
  }

  test("F — a reconnect that drops the reading post loads it back", async ({
    page,
  }) => {
    await installMockBridge(page);
    await page.goto("/");
    await page.getByTestId("channel-general").click();
    await expect(page.getByTestId("chat-title")).toHaveText("general");
    await waitForMockLiveSubscription(page, "general");
    const timeline = page.getByTestId("message-timeline");
    await timeline.hover();
    await page.mouse.wheel(0, 5000);
    await emitMessages(page, "general", "Deep", 140, 5);
    await expect.poll(() => isInViewport(page, "Deep 140")).toBe(true);

    // Read far back: older than the newest page a reconnect refetches.
    for (let i = 0; i < 6; i += 1) await page.mouse.wheel(0, -500);
    await page.waitForTimeout(500);
    const reading = await middleVisiblePost(page, "Deep ");
    expect(reading).not.toBeNull();
    expect(Number(reading?.split(" ")[1])).toBeLessThan(80);

    await page.evaluate(() =>
      (
        window as Window & {
          __BUZZ_E2E_RESTART_MOCK_WEBSOCKETS__?: () => number;
        }
      ).__BUZZ_E2E_RESTART_MOCK_WEBSOCKETS__?.(),
    );
    // The refresh lands about a second after the reconnect, and each older
    // page commits once the scroller is at rest, so a deep restore takes a
    // few seconds: judge the position only after that.
    await page.waitForTimeout(3000);
    await expect
      .poll(() => isInViewport(page, reading as string), { timeout: 20000 })
      .toBe(true);
    expect(await isInViewport(page, "Deep 140")).toBe(false);
  });

  test("G — returning to a channel goes back to where the reader left it", async ({
    page,
  }) => {
    await installMockBridge(page);
    await page.goto("/");
    await page.getByTestId("channel-general").click();
    await expect(page.getByTestId("chat-title")).toHaveText("general");
    await waitForMockLiveSubscription(page, "general");
    const timeline = page.getByTestId("message-timeline");
    await timeline.hover();
    await page.mouse.wheel(0, 5000);
    // History the reader has already read, like a news channel they are
    // caught up on: dated in the past but after the channel's seeded posts
    // (60 s old), so it is the newest content and sits at the bottom.
    await emitMessages(page, "general", "Card", 50, -58);
    await expect.poll(() => isInViewport(page, "Card 50")).toBe(true);
    await page.waitForTimeout(500);

    // Nothing new, but the reader stops a little above the end and leaves:
    // far from both the oldest history and the posts that arrive later, so
    // only returning to this exact spot keeps it on screen.
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(500);
    const reading = await middleVisiblePost(page, "Card ");
    expect(reading).not.toBeNull();
    await page.getByTestId("channel-random").click();
    await expect(page.getByTestId("chat-title")).toHaveText("random");

    // New posts arrive while they are elsewhere.
    await emitMessages(page, "general", "Later", 5, 200);

    await page.getByTestId("channel-general").click();
    await expect(page.getByTestId("chat-title")).toHaveText("general");
    await page.waitForTimeout(1000);
    expect(await isInViewport(page, reading as string)).toBe(true);
    expect(await isInViewport(page, "Later 5")).toBe(false);
    expect(await isInViewport(page, "Card 1")).toBe(false);
  });
});
