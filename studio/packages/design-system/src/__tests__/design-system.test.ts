import { describe, it, expect } from "vitest";
import {
  THEME_CSS,
  SVG_CLASSES_CSS,
  FORM_STYLES_CSS,
  INITIAL_RENDER_STAGGER_CSS,
  FORM_STYLES_WITH_STAGGER_CSS,
  VENDOR_LIBS_SCRIPT_TAGS,
} from "../index.js";

// Built via join so the single-source guard test only matches real CSS definitions.
const TOKEN_DEFINITION = ["--color-background-primary", ":"].join("");

describe("THEME_CSS", () => {
  it("defines the design-system color tokens", () => {
    expect(THEME_CSS).toContain(TOKEN_DEFINITION);
  });

  it("includes dark-mode overrides", () => {
    expect(THEME_CSS).toContain("@media (prefers-color-scheme: dark)");
  });
});

describe("SVG_CLASSES_CSS", () => {
  it("includes the pre-built SVG color classes", () => {
    expect(SVG_CLASSES_CSS).toContain(".c-purple");
  });
});

describe("FORM_STYLES_CSS", () => {
  it("styles form elements", () => {
    expect(FORM_STYLES_CSS).toContain('input[type="text"],');
    expect(FORM_STYLES_CSS).toContain("button {");
  });

  it("does not include the initial-render stagger block", () => {
    expect(FORM_STYLES_CSS).not.toContain(".initial-render");
  });
});

describe("INITIAL_RENDER_STAGGER_CSS", () => {
  it("contains the initial-render stagger rules", () => {
    expect(INITIAL_RENDER_STAGGER_CSS).toContain(".initial-render");
  });
});

describe("FORM_STYLES_WITH_STAGGER_CSS", () => {
  it("contains the initial-render stagger rules", () => {
    expect(FORM_STYLES_WITH_STAGGER_CSS).toContain(".initial-render");
    expect(FORM_STYLES_WITH_STAGGER_CSS).toContain(INITIAL_RENDER_STAGGER_CSS);
  });
});

describe("VENDOR_LIBS_SCRIPT_TAGS", () => {
  it("inlines d3 and Chart.js with no network references", () => {
    expect(VENDOR_LIBS_SCRIPT_TAGS).toContain('data-vendor="d3@');
    expect(VENDOR_LIBS_SCRIPT_TAGS).toContain('data-vendor="chart.js@');
    expect(VENDOR_LIBS_SCRIPT_TAGS).not.toMatch(/esm\.sh|jsdelivr|unpkg|cdnjs/);
    expect(VENDOR_LIBS_SCRIPT_TAGS).not.toContain("importmap");
  });

  it("never closes a script tag early", () => {
    const closers = VENDOR_LIBS_SCRIPT_TAGS.match(/<\/script>/g) ?? [];
    const openers = VENDOR_LIBS_SCRIPT_TAGS.match(/<script[ >]/g) ?? [];
    expect(closers.length).toBe(openers.length);
  });
});
