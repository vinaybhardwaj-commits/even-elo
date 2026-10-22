import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("@copilotkit/react-core/v2", () => ({
  CopilotChat: () => <div data-testid="chat">chat</div>,
  useAgent: () => ({ agent: {} }),
}));
vi.mock("@/hooks", () => ({ useGenerativeUIExamples: () => {} }));
vi.mock("@/lib/use-run-error", () => ({ useRunError: () => ({ error: null, onError: () => {} }) }));
vi.mock("../studio-nav", () => ({ StudioNav: () => <nav /> }));

import { ScreenFrame } from "../screen-frame";

const setWide = (matches: boolean) =>
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (q: string) => ({ matches, media: q, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }),
  });

const panelOpen = () => document.getElementById("screen-ask")!.getAttribute("data-open");

beforeEach(() => setWide(false));
afterEach(() => cleanup());

describe("ScreenFrame assistant panel", () => {
  it("narrow: the overlay panel has its own close button, which closes it and returns focus to the toggle", () => {
    // Live: below 1100 px the open panel covers the header toggle, so it could not be closed by clicking, and a click
    // aimed at the toggle landed on the chat (a message's copy button wrote to the clipboard).
    render(<ScreenFrame title="Programme overview">body</ScreenFrame>);
    expect(panelOpen()).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Ask the assistant" }));
    expect(panelOpen()).toBe("true");
    const close = screen.getByRole("button", { name: "Close assistant" });
    expect(document.getElementById("screen-ask")).toContainElement(close);
    fireEvent.click(close);
    expect(panelOpen()).toBe("false");
    expect(screen.getByRole("button", { name: "Ask the assistant" })).toHaveFocus();
  });

  it("narrow: Escape closes the overlay panel", () => {
    render(<ScreenFrame title="Programme overview">body</ScreenFrame>);
    fireEvent.click(screen.getByRole("button", { name: "Ask the assistant" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(panelOpen()).toBe("false");
    expect(screen.getByRole("button", { name: "Ask the assistant" })).toHaveFocus();
  });

  it("narrow: Escape already handled inside the chat, or ending an IME composition, leaves the panel open", () => {
    render(<ScreenFrame title="Programme overview">body</ScreenFrame>);
    fireEvent.click(screen.getByRole("button", { name: "Ask the assistant" }));
    const chat = screen.getByTestId("chat");
    const stop = (e: KeyboardEvent) => e.preventDefault();
    chat.addEventListener("keydown", stop);
    fireEvent.keyDown(chat, { key: "Escape" });
    expect(panelOpen()).toBe("true");
    chat.removeEventListener("keydown", stop);
    fireEvent.keyDown(chat, { key: "Escape", isComposing: true });
    expect(panelOpen()).toBe("true");
    fireEvent.keyDown(chat, { key: "Escape" });
    expect(panelOpen()).toBe("false");
  });

  it("wide: Escape leaves the docked panel alone (it covers nothing)", () => {
    setWide(true);
    render(<ScreenFrame title="Programme overview">body</ScreenFrame>);
    expect(panelOpen()).toBe("true");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(panelOpen()).toBe("true");
  });
});
