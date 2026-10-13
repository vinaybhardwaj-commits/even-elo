import { describe, it, expect } from "vitest";
import {
  buildFinalFrameContent,
  CSP_CONTENT,
  PREVIEW_FRAME_CONTENT,
} from "../frame-content";

function parse(html: string) {
  return new DOMParser().parseFromString(html, "text/html");
}

function assertCspIsFirstInRealHead(html: string) {
  const doc = parse(buildFinalFrameContent(html, "body{--m:1}"));
  const first = doc.head.firstElementChild as HTMLMetaElement;
  expect(first.tagName).toBe("META");
  expect(first.httpEquiv).toBe("Content-Security-Policy");
  expect(first.content).toBe(CSP_CONTENT);
  // exactly one CSP meta is ours, and none lives in the body
  expect(doc.body.querySelector('meta[http-equiv="Content-Security-Policy"]')).toBeNull();
  return doc;
}

describe("buildFinalFrameContent head handling", () => {
  const cases: Record<string, string> = {
    "<header> before <head>": "<header>h</header><head><title>t</title></head><body><p>x</p></body>",
    "<head data-x>": '<head data-x="1"><title>t</title></head><body><p>x</p></body>',
    "no head": "<body><p>x</p></body>",
    "bare fragment": "<div>x</div>",
    "multiple heads": "<head><title>a</title></head><head><title>b</title></head><body>x</body>",
    "uppercase": "<HEAD><TITLE>t</TITLE></HEAD><BODY>x</BODY>",
    "head tag inside a comment": "<!-- <head> --><body>x</body>",
    "head tag inside a script string": '<script>var s="<head>";</script><body>x</body>',
    "full document": "<!doctype html><html lang=en><head></head><body>x</body></html>",
  };
  for (const [name, html] of Object.entries(cases)) {
    it(`puts the CSP meta first in a real <head>: ${name}`, () => {
      assertCspIsFirstInRealHead(html);
    });
  }

  it("keeps a literal <head> for websandbox and starts with a doctype", () => {
    const out = buildFinalFrameContent("<body>x</body>");
    expect(out.startsWith("<!DOCTYPE html><head>")).toBe(true);
    expect(out.indexOf("<head>")).toBeLessThan(out.indexOf("Content-Security-Policy") );
  });

  it("preview frame carries the CSP first as well", () => {
    const doc = parse(PREVIEW_FRAME_CONTENT);
    expect((doc.head.firstElementChild as HTMLMetaElement).content).toBe(CSP_CONTENT);
  });

  it("generated head content stays after ours", () => {
    const doc = assertCspIsFirstInRealHead("<head><title>t</title></head><body>x</body>");
    const kids = Array.from(doc.head.children).map((c) => c.tagName);
    expect(kids.indexOf("META")).toBe(0);
    expect(kids).toContain("TITLE");
  });
});
