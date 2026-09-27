/**
 * Hook-level tests for restoring a mid-history reader after a head refresh
 * (subscribe / relay reconnect) replaced the loaded window with the newest
 * page and dropped the row they were reading.
 *
 * Uses the DOM shim from useAnchoredScroll.lifecycle.test.mjs; the list is a
 * fake virtualizer so every step (loss, page requests, return) is driven
 * explicitly and deterministically.
 */
import assert from "node:assert/strict";
import test from "node:test";

function installDOMShim() {
  class EventTargetShim {
    constructor() {
      this.listeners = new Map();
    }

    addEventListener(type, listener) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }

    removeEventListener(type, listener) {
      this.listeners.set(
        type,
        (this.listeners.get(type) ?? []).filter(
          (current) => current !== listener,
        ),
      );
    }

    dispatchEvent(event) {
      for (const listener of this.listeners.get(event.type) ?? [])
        listener(event);
      return true;
    }
  }

  class NodeShim extends EventTargetShim {
    constructor(tagName) {
      super();
      this.tagName = tagName;
      this.nodeName = tagName.toUpperCase();
      this.nodeType = 1;
      this.namespaceURI = "http://www.w3.org/1999/xhtml";
      this.children = [];
      this.childNodes = [];
      this.style = {};
      this.parentNode = null;
    }

    get ownerDocument() {
      return globalThis.document;
    }

    get firstChild() {
      return this.children[0] ?? null;
    }

    get firstElementChild() {
      return this.children[0] ?? null;
    }

    get lastChild() {
      return this.children.at(-1) ?? null;
    }

    get nextSibling() {
      return null;
    }

    get nodeValue() {
      return null;
    }

    appendChild(child) {
      this.children.push(child);
      this.childNodes.push(child);
      child.parentNode = this;
      return child;
    }

    removeChild(child) {
      this.children = this.children.filter((current) => current !== child);
      this.childNodes = this.childNodes.filter((current) => current !== child);
      child.parentNode = null;
      return child;
    }

    insertBefore(child, reference) {
      if (!reference) return this.appendChild(child);
      const index = this.children.indexOf(reference);
      if (index < 0) return this.appendChild(child);
      this.children.splice(index, 0, child);
      this.childNodes.splice(index, 0, child);
      child.parentNode = this;
      return child;
    }

    contains(node) {
      return (
        this === node || this.children.some((child) => child.contains(node))
      );
    }
  }

  class DocumentShim extends EventTargetShim {
    constructor() {
      super();
      this.nodeType = 9;
      this.defaultView = globalThis;
    }

    createElement(tagName) {
      return new NodeShim(tagName);
    }

    createTextNode(value) {
      const node = new NodeShim("#text");
      node.nodeType = 3;
      node.nodeValue = value;
      return node;
    }

    createComment(value) {
      const node = new NodeShim("#comment");
      node.nodeType = 8;
      node.nodeValue = value;
      return node;
    }

    get activeElement() {
      return null;
    }
  }

  globalThis.document = new DocumentShim();
  const windowEvents = new EventTargetShim();
  globalThis.addEventListener =
    windowEvents.addEventListener.bind(windowEvents);
  globalThis.removeEventListener =
    windowEvents.removeEventListener.bind(windowEvents);
  globalThis.dispatchEvent = windowEvents.dispatchEvent.bind(windowEvents);
  globalThis.HTMLIFrameElement = NodeShim;
  globalThis.HTMLDivElement = NodeShim;
  globalThis.HTMLElement = NodeShim;
  globalThis.Node = NodeShim;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  process.env.IS_REACT_ACT_ENVIRONMENT = "true";
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: globalThis,
  });
  globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  globalThis.CSS = { escape: (value) => value };
}

installDOMShim();

import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { useAnchoredScroll } from "./useAnchoredScroll.ts";

const range = (from, to) =>
  Array.from({ length: to - from + 1 }, (_, index) => ({
    id: `m${from + index}`,
  }));

/** A mid-history scroll container; rows are virtualized, so none resolve. */
function makeContainer() {
  return {
    clientHeight: 400,
    listeners: new Map(),
    scrollHeight: 4_000,
    scrollTop: 1_200,
    addEventListener(type, listener) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    },
    removeEventListener(type, listener) {
      this.listeners.set(
        type,
        (this.listeners.get(type) ?? []).filter((l) => l !== listener),
      );
    },
    dispatchEvent(event) {
      for (const listener of this.listeners.get(event.type) ?? [])
        listener(event);
    },
    getBoundingClientRect() {
      return { bottom: this.clientHeight, top: 0 };
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    scrollBy() {},
    scrollTo() {},
  };
}

function RestoreHarness({ messages, refs, requestOlder, calls }) {
  const anchored = useAnchoredScroll({
    channelId: "news",
    contentRef: refs.content,
    isLoading: false,
    messages,
    scrollContainerRef: refs.container,
    requestOlder,
    virtualizerOwnsPrependAnchoring: true,
    virtualCancelBottomIntent: () => {},
    virtualScrollToBottom: () => calls.push("bottom"),
    virtualSettleAtBottom: () => calls.push("settle"),
    virtualScrollToMessage: (id) => {
      calls.push(`scrollTo:${id}`);
      return true;
    },
    virtualReadingPosition: () => ({ messageId: "m20", topOffset: 40 }),
  });
  refs.anchored.current = anchored;
  return null;
}

async function setup(requestOlder) {
  globalThis.ResizeObserver = class {
    disconnect() {}
    observe() {}
  };
  const container = makeContainer();
  const refs = {
    anchored: { current: null },
    container: { current: container },
    content: { current: {} },
  };
  const calls = [];
  const root = createRoot(document.createElement("div"));
  const render = (messages) =>
    act(async () => {
      root.render(
        React.createElement(RestoreHarness, {
          calls,
          messages,
          refs,
          requestOlder,
        }),
      );
    });
  // Open with the whole channel loaded, then the reader scrolls back to m20.
  await render(range(1, 100));
  await act(async () => {
    refs.anchored.current.onVirtualizerAtBottomStateChange(false);
  });
  calls.length = 0;
  return { calls, container, render, root };
}

test("a head refresh that drops the reading row loads older pages until it is back", async () => {
  const requests = [];
  const { calls, render, root } = await setup(() => {
    requests.push("older");
    return "requested";
  });

  // Reconnect: only the newest page remains.
  await render(range(51, 100));
  assert.equal(requests.length, 1, "asks for one older page");
  assert.deepEqual(calls, [], "the view is held, not pinned to the floor");

  // First older page: still short of m20.
  await render(range(26, 100));
  assert.equal(requests.length, 2);

  // Second older page brings m20 back: return the reader to it.
  await render(range(1, 100));
  assert.equal(requests.length, 2, "no further pages once the row is back");
  assert.deepEqual(calls, ["scrollTo:m20"]);
  await act(async () => root.unmount());
});

test("one page per committed list: re-renders with the same messages do not stack fetches", async () => {
  const requests = [];
  const { render, root } = await setup(() => {
    requests.push("older");
    return "requested";
  });
  const newest = range(51, 100);
  await render(newest);
  await render(newest);
  await render(newest);
  assert.equal(requests.length, 1);
  await act(async () => root.unmount());
});

test("the reader taking over cancels the restore", async () => {
  const requests = [];
  const { calls, container, render, root } = await setup(() => {
    requests.push("older");
    return "requested";
  });
  await render(range(51, 100));
  assert.equal(requests.length, 1);

  await act(async () => {
    container.dispatchEvent({ type: "wheel" });
  });
  await render(range(26, 100));
  await render(range(1, 100));
  assert.equal(requests.length, 1, "no pages after the reader's input");
  assert.deepEqual(calls, [], "and no scroll back to the old row");
  await act(async () => root.unmount());
});

test("history running out ends the restore", async () => {
  const requests = [];
  const { calls, render, root } = await setup(() => {
    requests.push("older");
    return "exhausted";
  });
  await render(range(51, 100));
  await render(range(51, 101));
  assert.equal(requests.length, 1, "no retry once history is exhausted");
  assert.deepEqual(
    calls.filter((call) => call.startsWith("scrollTo")),
    [],
  );
  await act(async () => root.unmount());
});

test("the restore is bounded when the row never comes back", async () => {
  const requests = [];
  const { render, root } = await setup(() => {
    requests.push("older");
    return "requested";
  });
  // Each "page" commits a new list that still lacks m20.
  for (let size = 50; size <= 70; size += 1) {
    await render(range(101 - size, 100).filter((m) => m.id !== "m20"));
  }
  assert.equal(requests.length, 10);
  await act(async () => root.unmount());
});
