import { expect, test } from "@playwright/test";

import { TEST_IDENTITIES, installMockBridge } from "../helpers/bridge";
import { waitForAnimations } from "../helpers/animations";

const MOCK_PUBKEY = "deadbeef".repeat(8);
const ENGINEERING_CHANNEL_ID = "1c7e1c02-87bb-5e88-b2da-5a7a9432d0c9";
const COUNT_STORAGE_KEY = `buzz-channel-unread-counts.v1:${MOCK_PUBKEY}`;
const MUTE_STORAGE_KEY = `buzz-channel-mutes.v1:${MOCK_PUBKEY}`;

type Page = import("@playwright/test").Page;

function seedFlag(page: Page, key: string, field: string, channelId: string) {
  return page.addInitScript(
    ({ key, field, id }) => {
      localStorage.setItem(
        key,
        JSON.stringify({
          version: 1,
          channels: { [id]: { [field]: true, updatedAt: 1700000000 } },
        }),
      );
    },
    { key, field, id: channelId },
  );
}

async function waitForMockLiveSubscription(page: Page, channelName: string) {
  await expect
    .poll(async () =>
      page.evaluate(
        ({ ch }) =>
          (
            window as Window & {
              __BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?: (input: {
                channelName: string;
                kind: number;
                exactChannel: boolean;
              }) => boolean;
            }
          ).__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?.({
            channelName: ch,
            kind: 9,
            exactChannel: true,
          }) ?? false,
        { ch: channelName },
      ),
    )
    .toBe(true);
}

/** Visit a channel so its live subscription exists, then move away from it. */
async function openThenLeave(page: Page, channelName: string) {
  await page.goto("/");
  await page.getByTestId(`channel-${channelName}`).click();
  await expect(page.getByTestId("chat-title")).toHaveText(channelName);
  await waitForMockLiveSubscription(page, channelName);
  await page.getByTestId("channel-random").click();
  await expect(page.getByTestId("chat-title")).toHaveText("random");
  await waitForMockLiveSubscription(page, channelName);
}

async function emitPosts(page: Page, channelName: string, count: number) {
  await page.evaluate(
    ({ channelName, count, pubkey }) => {
      const emit = (
        window as Window & {
          __BUZZ_E2E_EMIT_MOCK_MESSAGE__?: (input: {
            channelName: string;
            content: string;
            pubkey: string;
          }) => unknown;
        }
      ).__BUZZ_E2E_EMIT_MOCK_MESSAGE__;
      for (let index = 1; index <= count; index += 1) {
        emit?.({ channelName, content: `News item ${index}`, pubkey });
      }
    },
    { channelName, count, pubkey: TEST_IDENTITIES.alice.pubkey },
  );
}

test.describe("channel unread counts", () => {
  test("01 — Show unread count is offered and works from the keyboard", async ({
    page,
  }) => {
    await installMockBridge(page);
    await page.goto("/");
    await page.getByTestId("channel-random").click();
    await expect(page.getByTestId("chat-title")).toHaveText("random");

    await page.getByTestId("channel-engineering").click({ button: "right" });
    const item = page.getByRole("menuitem", { name: "Show unread count" });
    await expect(item).toBeVisible();
    await waitForAnimations(page);
    await item.focus();
    await page.keyboard.press("Enter");
    await expect(item).toBeHidden();

    await expect
      .poll(() =>
        page.evaluate(
          (key) => JSON.parse(localStorage.getItem(key) ?? "null"),
          COUNT_STORAGE_KEY,
        ),
      )
      .toMatchObject({
        version: 1,
        channels: { [ENGINEERING_CHANNEL_ID]: { enabled: true } },
      });
  });

  test("02 — direct messages do not offer the toggle", async ({ page }) => {
    await installMockBridge(page);
    await page.goto("/");
    await page.getByTestId("channel-alice-tyler").click({ button: "right" });
    await expect(
      page.getByRole("menuitem", { name: "Mute channel" }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "Show unread count" }),
    ).toHaveCount(0);
  });

  test("03 — an opted-in channel shows how many posts are unread", async ({
    page,
  }) => {
    await seedFlag(page, COUNT_STORAGE_KEY, "enabled", ENGINEERING_CHANNEL_ID);
    await installMockBridge(page);
    await openThenLeave(page, "engineering");

    await emitPosts(page, "engineering", 3);

    const badge = page.getByTestId("channel-unread-engineering");
    await expect(badge).toContainText("3");
    await expect(badge).toContainText("3 unread messages");
    await expect(
      page.getByTestId("channel-unread-dot-engineering"),
    ).toHaveCount(0);
  });

  test("04 — channels that did not opt in stay bold without a number", async ({
    page,
  }) => {
    await installMockBridge(page);
    await openThenLeave(page, "engineering");

    await emitPosts(page, "engineering", 3);

    await expect(page.getByTestId("channel-engineering")).toHaveCSS(
      "font-weight",
      "700",
    );
    await expect(page.getByTestId("channel-unread-engineering")).toHaveCount(0);
  });

  test("05 — mute wins over an unread count", async ({ page }) => {
    await seedFlag(page, COUNT_STORAGE_KEY, "enabled", ENGINEERING_CHANNEL_ID);
    await seedFlag(page, MUTE_STORAGE_KEY, "muted", ENGINEERING_CHANNEL_ID);
    await installMockBridge(page);
    await openThenLeave(page, "engineering");

    await emitPosts(page, "engineering", 3);

    const row = page.getByTestId("channel-engineering");
    await expect(row.locator("svg.lucide-bell-off")).toHaveCount(1);
    await expect(page.getByTestId("channel-unread-engineering")).toHaveCount(0);
  });

  test("06 — Hide unread count removes the number", async ({ page }) => {
    await seedFlag(page, COUNT_STORAGE_KEY, "enabled", ENGINEERING_CHANNEL_ID);
    await installMockBridge(page);
    await openThenLeave(page, "engineering");
    await emitPosts(page, "engineering", 2);
    await expect(page.getByTestId("channel-unread-engineering")).toContainText(
      "2",
    );

    await page.getByTestId("channel-engineering").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Hide unread count" }).click();

    await expect(page.getByTestId("channel-unread-engineering")).toHaveCount(0);
    await expect(page.getByTestId("channel-engineering")).toHaveCSS(
      "font-weight",
      "700",
    );
  });

  test("07 — the open channel counts the posts below the screen", async ({
    page,
  }) => {
    await seedFlag(page, COUNT_STORAGE_KEY, "enabled", ENGINEERING_CHANNEL_ID);
    await installMockBridge(page);
    await page.goto("/");
    await page.getByTestId("channel-engineering").click();
    await expect(page.getByTestId("chat-title")).toHaveText("engineering");
    await waitForMockLiveSubscription(page, "engineering");
    const timeline = page.getByTestId("message-timeline");
    await timeline.hover();
    await page.mouse.wheel(0, 5000);
    await emitPosts(page, "engineering", 40);
    await page.waitForTimeout(500);
    const badge = page.getByTestId("channel-unread-engineering");
    // At the bottom nothing is below the screen.
    await expect(badge).toHaveCount(0);

    // Scrolling up leaves posts below: the open channel shows how many.
    for (let i = 0; i < 3; i += 1) await page.mouse.wheel(0, -400);
    await expect(badge).toBeVisible();
    // Let scrolling and row measurement settle: read until two reads agree.
    const readCount = async () =>
      Number((await badge.innerText()).split(/\s/)[0]);
    let scrolledUp = -1;
    await expect
      .poll(async () => {
        const previous = scrolledUp;
        await page.waitForTimeout(300);
        scrolledUp = await readCount();
        return scrolledUp === previous;
      })
      .toBe(true);
    expect(scrolledUp).toBeGreaterThan(0);

    // New posts arriving while scrolled up add to it.
    await emitPosts(page, "engineering", 3);
    await expect.poll(readCount).toBe(scrolledUp + 3);

    // Reaching the bottom clears it. Posts held back while scrolled up are
    // released by the trackpad's momentum at the floor (the first arrival is
    // deliberately ignored); emulate it with a nudge up and back down.
    await page.mouse.wheel(0, 5000);
    await page.waitForTimeout(300);
    await page.mouse.wheel(0, -60);
    await page.waitForTimeout(150);
    await page.mouse.wheel(0, 5000);
    await page.waitForTimeout(500);
    await page.mouse.wheel(0, 5000);
    await expect(badge).toHaveCount(0);
  });
});
