import { describe, expect, it } from "vitest";
import {
  DEFAULT_UPLOAD_HOST,
  isOtCaptureEnabled,
  isPublicCaptureApi,
  isPublicCapturePage,
  isUploadCaptureHost,
} from "../access";
import { looksLikeImage, normalizeHospital, planImages, resolveImageType } from "../images";
import { clientIpFromHeaders, hashIp, ipHashPrefix, sanitizeUploaderName, truncateUserAgent } from "../provenance";
import {
  captureProvenance,
  captureQueueTitle,
  headlineCount,
  publicCaptureHasBlobLocator,
  toPublicCapture,
} from "../present";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const HTML = new TextEncoder().encode("<html>not an image</html>");

describe("FEATURE_OT_CAPTURE", () => {
  it("is on only for exact true", () => {
    expect(isOtCaptureEnabled({ FEATURE_OT_CAPTURE: "true" })).toBe(true);
    expect(isOtCaptureEnabled({ FEATURE_OT_CAPTURE: " true " })).toBe(true);
    expect(isOtCaptureEnabled({})).toBe(false);
    expect(isOtCaptureEnabled({ FEATURE_OT_CAPTURE: "false" })).toBe(false);
    expect(isOtCaptureEnabled({ FEATURE_OT_CAPTURE: "1" })).toBe(false);
    expect(isOtCaptureEnabled({ FEATURE_OT_CAPTURE: "TRUE" })).toBe(false);
  });
});

describe("capture host and public paths", () => {
  it("matches the upload host and an optional extra host, ignoring the port", () => {
    expect(isUploadCaptureHost(`${DEFAULT_UPLOAD_HOST}:443`, {})).toBe(true);
    expect(isUploadCaptureHost("governance.evenos.app", {})).toBe(false);
    expect(
      isUploadCaptureHost("preview.example", { OT_CAPTURE_UPLOAD_HOSTS: "preview.example, other.test" }),
    ).toBe(true);
  });

  it("opens only the capture page and the upload API", () => {
    expect(isPublicCapturePage("/capture")).toBe(true);
    expect(isPublicCapturePage("/capture/")).toBe(true);
    expect(isPublicCapturePage("/surgical-governance/capture-queue")).toBe(false);
    expect(isPublicCaptureApi("/api/capture/upload")).toBe(true);
    expect(isPublicCaptureApi("/api/capture/queue")).toBe(false);
    expect(isPublicCaptureApi("/api/capture/abc/image")).toBe(false);
  });
});

describe("image planning", () => {
  it("accepts jpeg, png, webp, and heic by type or extension", () => {
    expect(resolveImageType("image/jpeg", "a.bin")?.ext).toBe("jpg");
    expect(resolveImageType("", "sheet.HEIC")?.contentType).toBe("image/heic");
    expect(resolveImageType("image/svg+xml", "x.svg")).toBeNull();
    expect(looksLikeImage(JPEG, "jpg")).toBe(true);
    expect(looksLikeImage(PNG, "png")).toBe(true);
    expect(looksLikeImage(HTML, "jpg")).toBe(false);
  });

  it("rejects empty batches, non-images, and oversize files", () => {
    expect(planImages([]).ok).toBe(false);
    const html = planImages([{ filename: "note.jpg", contentType: "image/jpeg", bytes: HTML }]);
    expect(html.ok).toBe(false);
    const big = new Uint8Array(4 * 1024 * 1024 + 1);
    big.set(JPEG);
    const over = planImages([{ filename: "big.jpg", contentType: "image/jpeg", bytes: big }]);
    expect(over.ok).toBe(false);
    const ok = planImages([{ filename: "sheet.jpg", contentType: "image/jpeg", bytes: JPEG }]);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.images[0]?.contentType).toBe("image/jpeg");
  });

  it("defaults hospital to EHRC and rejects unknown codes", () => {
    expect(normalizeHospital(null)).toEqual({ ok: true, code: "EHRC" });
    expect(normalizeHospital(" ehbr ")).toEqual({ ok: true, code: "EHBR" });
    expect(normalizeHospital("EHXX").ok).toBe(false);
  });
});

describe("provenance", () => {
  it("hashes the IP and never echoes it", () => {
    const ip = "203.0.113.55";
    const hash = hashIp(ip, "salt-a");
    expect(hash).toHaveLength(64);
    expect(hash).not.toContain(ip);
    expect(hashIp(ip, "salt-a")).toBe(hash);
    expect(hashIp(ip, "salt-b")).not.toBe(hash);
    expect(ipHashPrefix(hash)).toBe(hash.slice(0, 8));
  });

  it("reads the first forwarded address only", () => {
    const headers = new Headers({ "x-forwarded-for": "203.0.113.55, 10.0.0.1" });
    expect(clientIpFromHeaders(headers)).toBe("203.0.113.55");
    expect(clientIpFromHeaders(new Headers())).toBeNull();
  });

  it("trims the optional uploader name and user agent", () => {
    expect(sanitizeUploaderName("  OT coordinator — floor 2  ")).toBe("OT coordinator — floor 2");
    expect(sanitizeUploaderName("   ")).toBeNull();
    expect(sanitizeUploaderName("a".repeat(200))?.length).toBe(120);
    expect(truncateUserAgent("Mozilla/5.0\n(iPhone)")).toBe("Mozilla/5.0 (iPhone)");
  });
});

describe("queue presentation", () => {
  it("names a batch the way the capture queue reads", () => {
    expect(
      captureQueueTitle({
        uploadedBy: "Priya N (OT)",
        batchSize: 2,
        photoIndex: 1,
        filename: "a.jpg",
      }),
    ).toContain("Batch · 2 photos");
    expect(
      captureQueueTitle({
        uploadedBy: "Priya N (OT)",
        batchSize: 2,
        photoIndex: 1,
        filename: "a.jpg",
      }),
    ).toContain("Priya N (OT)");
  });

  it("drops blob locators and the full IP hash from the staff DTO", () => {
    const item = toPublicCapture({
      id: "11111111-1111-1111-1111-111111111111",
      hospital_code: "EHRC",
      uploaded_by: "Priya N (OT)",
      uploaded_at: "2026-09-27T05:12:00.000Z",
      user_agent: "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X)",
      ip_hash: "a3f9c2d4e5f60718293a4b5c6d7e8f90",
      content_type: "image/jpeg",
      bytes: 1200,
      status: "queued",
      batch_id: "22222222-2222-2222-2222-222222222222",
      photo_index: 1,
      batch_size: 2,
      original_filename: "sheet.jpg",
      blob_pathname: "ot-captures/EHRC/secret.jpg",
      blob_url: "https://private.blob.vercel-storage.com/secret",
    });
    expect(publicCaptureHasBlobLocator(item)).toBe(false);
    expect(item.image_path).toBe("/api/capture/11111111-1111-1111-1111-111111111111/image");
    expect(item.provenance).toContain("a3f9c2d4…");
    expect(item.provenance).not.toContain("a3f9c2d4e5");
    expect(JSON.stringify(item)).not.toContain("blob.vercel");
    expect(JSON.stringify(item)).not.toContain("ot-captures/");
  });

  it("folds stored into the queued headline", () => {
    expect(headlineCount({ queued: 1, stored: 2, extracted: 4 }, "queued")).toBe(3);
    expect(headlineCount({ extracted: 4 }, "extracted")).toBe(4);
    expect(captureProvenance({ userAgent: null, ipHash: null })).toContain("IP hash —");
  });
});
