/**
 * Hook-level tests for returning a reader to where they left a channel.
 *
 * Uses the DOM shim from useAnchoredScroll.lifecycle.test.mjs with a fake
 * virtualizer and an in-memory localStorage, so leaving and reopening a
 * channel is driven deterministically.
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

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};

import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { useAnchoredScroll } from "./useAnchoredScroll.ts";

const range = (prefix, from, to) =>
  Array.from({ length: to - from + 1 }, (_, index) => ({
    id: `${prefix}${from + index}`,
  }));

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

function Harness({ channelId, messages, initialMessageId, refs, calls }) {
  const anchored = useAnchoredScroll({
    channelId,
    contentRef: refs.content,
    initialMessageId,
    isLoading: false,
    messages,
    scrollContainerRef: refs.container,
    virtualizerOwnsPrependAnchoring: true,
    virtualCancelBottomIntent: () => {},
    virtualScrollToBottom: () => calls.push("bottom"),
    virtualSettleAtBottom: () => {},
    virtualScrollToMessage: (id) => {
      calls.push(`scrollTo:${id}`);
      return true;
    },
    virtualReadingPosition: () => refs.reading.current,
  });
  refs.anchored.current = anchored;
  return null;
}

async function setup() {
  storage.clear();
  globalThis.ResizeObserver = class {
    disconnect() {}
    observe() {}
  };
  const refs = {
    anchored: { current: null },
    container: { current: makeContainer() },
    content: { current: {} },
    reading: { current: null },
  };
  const calls = [];
  const root = createRoot(document.createElement("div"));
  const show = (props) =>
    act(async () => {
      root.render(React.createElement(Harness, { calls, refs, ...props }));
    });
  return { calls, refs, root, show };
}

const news = range("n", 1, 60);
const other = range("o", 1, 10);

test("reopening a channel returns to where the reader left it, over its first unread post", async () => {
  const { calls, refs, root, show } = await setup();
  await show({ channelId: "news", messages: news, initialMessageId: null });

  // The reader scrolls back to n40 and leaves for another channel.
  refs.reading.current = { messageId: "n40", topOffset: 60 };
  await act(async () => {
    refs.anchored.current.onVirtualizerAtBottomStateChange(false);
  });
  await show({ channelId: "other", messages: other, initialMessageId: null });

  // New posts arrived meanwhile: the first unread is n61, at the end.
  calls.length = 0;
  await show({
    channelId: "news",
    messages: range("n", 1, 65),
    initialMessageId: "n61",
  });
  assert.deepEqual(calls, ["scrollTo:n40"]);
  await act(async () => root.unmount());
});

test("a channel left at the bottom opens at its first unread post", async () => {
  const { calls, refs, root, show } = await setup();
  await show({ channelId: "news", messages: news, initialMessageId: null });
  refs.reading.current = null;
  await act(async () => {
    refs.anchored.current.onVirtualizerAtBottomStateChange(true);
  });
  await show({ channelId: "other", messages: other, initialMessageId: null });

  calls.length = 0;
  await show({
    channelId: "news",
    messages: range("n", 1, 65),
    initialMessageId: "n61",
  });
  assert.deepEqual(calls, ["scrollTo:n61"]);
  await act(async () => root.unmount());
});

test("with nothing remembered and nothing unread, a channel opens at the bottom", async () => {
  const { calls, root, show } = await setup();
  calls.length = 0;
  await show({ channelId: "news", messages: news, initialMessageId: null });
  // The open-time floor pin runs twice (now and on the next frame).
  assert.ok(calls.length > 0);
  assert.ok(calls.every((call) => call === "bottom"));
  await act(async () => root.unmount());
});
