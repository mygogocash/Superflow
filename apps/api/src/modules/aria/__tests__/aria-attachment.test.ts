import type { ManutAiAttachment } from "@nexora/database";
import { OfficeParser } from "officeparser";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";

import { BadRequestException } from "@/common/exceptions/http-exception";
import * as gemini from "@/infrastructure/ai/gemini";
import * as storage from "@/infrastructure/storage/supabase-storage";
import { ariaRepository } from "@/modules/aria/aria.repository";
import { ariaAttachmentService } from "@/modules/aria/aria-attachment.service";

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function mockUpload() {
  vi.spyOn(storage, "uploadFile").mockResolvedValue({
    path: "documents/u1/f",
    url: "x",
    bucket: "documents" as never,
  });
}

function att(over: Partial<ManutAiAttachment>): ManutAiAttachment {
  return {
    id: "a1",
    userId: "u1",
    messageId: null,
    kind: "document",
    name: "file",
    mimeType: "application/pdf",
    size: 10,
    storageBucket: "documents",
    storagePath: "documents/u1/file",
    extractedText: null,
    status: "ready",
    createdAt: new Date(),
    ...over,
  } as ManutAiAttachment;
}

const file = (mimeType: string, size: number, body = "x") => ({
  buffer: Buffer.from(body),
  originalName: "f",
  mimeType,
  size,
});

describe("uploadAttachment (validation + kind)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("rejects an unsupported MIME type", async () => {
    await expect(
      ariaAttachmentService.uploadAttachment("u1", file("video/mp4", 100)),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects an oversize image", async () => {
    await expect(
      ariaAttachmentService.uploadAttachment(
        "u1",
        file("image/png", 6 * 1024 * 1024),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("stores an image as kind=image with no extracted text", async () => {
    vi.spyOn(storage, "uploadFile").mockResolvedValue({
      path: "documents/u1/img",
      url: "x",
      bucket: "documents" as never,
    });
    const create = vi
      .spyOn(ariaRepository, "createAttachment")
      .mockImplementation(async (d) => att(d as never));
    await ariaAttachmentService.uploadAttachment(
      "u1",
      file("image/jpeg", 1000),
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "image", extractedText: null }),
    );
  });

  it("extracts text for a .txt/.csv doc", async () => {
    vi.spyOn(storage, "uploadFile").mockResolvedValue({
      path: "documents/u1/t",
      url: "x",
      bucket: "documents" as never,
    });
    const create = vi
      .spyOn(ariaRepository, "createAttachment")
      .mockImplementation(async (d) => att(d as never));
    await ariaAttachmentService.uploadAttachment(
      "u1",
      file("text/csv", 5, "a,b,c"),
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "document", extractedText: "a,b,c" }),
    );
  });

  it("extracts xlsx text via SheetJS (per-sheet CSV)", async () => {
    mockUpload();
    const create = vi
      .spyOn(ariaRepository, "createAttachment")
      .mockImplementation(async (d) => att(d as never));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ["Name", "Amount"],
        ["Alice", 42],
      ]),
      "Q1",
    );
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    await ariaAttachmentService.uploadAttachment("u1", {
      buffer: buf,
      originalName: "book.xlsx",
      mimeType: XLSX_MIME,
      size: buf.length,
    });
    const arg = create.mock.calls[0]![0] as { extractedText: string };
    expect(arg.extractedText).toContain("Alice");
    expect(arg.extractedText).toContain("42");
    expect(arg.extractedText).toContain("Q1");
  });

  it("extracts docx text via officeparser", async () => {
    mockUpload();
    vi.spyOn(OfficeParser, "parseOffice").mockResolvedValue({
      toText: () => "the contract body",
    } as never);
    const create = vi
      .spyOn(ariaRepository, "createAttachment")
      .mockImplementation(async (d) => att(d as never));
    await ariaAttachmentService.uploadAttachment("u1", {
      buffer: Buffer.from("PK"),
      originalName: "doc.docx",
      mimeType: DOCX_MIME,
      size: 2,
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "document",
        extractedText: "the contract body",
        status: "ready",
      }),
    );
  });

  it("transcribes a video via the Gemini Files API", async () => {
    mockUpload();
    vi.spyOn(gemini, "getGeminiClient").mockReturnValue({
      files: {
        upload: async () => ({
          name: "files/abc",
          state: "ACTIVE",
          uri: "https://g/files/abc",
        }),
        get: async () => ({ state: "ACTIVE", uri: "https://g/files/abc" }),
        delete: async () => undefined,
      },
      models: {
        generateContent: async () => ({ text: "Speaker 1: hello team" }),
      },
    } as never);
    const create = vi
      .spyOn(ariaRepository, "createAttachment")
      .mockImplementation(async (d) => att(d as never));
    await ariaAttachmentService.uploadAttachment("u1", {
      buffer: Buffer.from("VIDEOBYTES"),
      originalName: "standup.mp4",
      mimeType: "video/mp4",
      size: 10,
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "video",
        extractedText: "Speaker 1: hello team",
        status: "ready",
      }),
    );
  });

  it("marks a video failed when transcription yields nothing", async () => {
    mockUpload();
    vi.spyOn(gemini, "getGeminiClient").mockReturnValue({
      files: {
        upload: async () => ({ name: "files/x", state: "FAILED" }),
        get: async () => ({ state: "FAILED" }),
        delete: async () => undefined,
      },
      models: { generateContent: async () => ({ text: "" }) },
    } as never);
    const create = vi
      .spyOn(ariaRepository, "createAttachment")
      .mockImplementation(async (d) => att(d as never));
    await ariaAttachmentService.uploadAttachment("u1", {
      buffer: Buffer.from("V"),
      originalName: "bad.mp4",
      mimeType: "video/mp4",
      size: 1,
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "video", status: "failed" }),
    );
  });

  it("marks an Office doc failed when extraction yields nothing", async () => {
    mockUpload();
    vi.spyOn(OfficeParser, "parseOffice").mockRejectedValue(new Error("bad"));
    const create = vi
      .spyOn(ariaRepository, "createAttachment")
      .mockImplementation(async (d) => att(d as never));
    await ariaAttachmentService.uploadAttachment("u1", {
      buffer: Buffer.from("PK"),
      originalName: "doc.docx",
      mimeType: DOCX_MIME,
      size: 2,
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", extractedText: null }),
    );
  });
});

describe("buildAttachmentBlocks (Claude content blocks)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("builds a base64 image block for an image", async () => {
    vi.spyOn(storage, "downloadToBuffer").mockResolvedValue({
      buffer: Buffer.from("IMG"),
      contentType: "image/png",
    });
    const [block] = (await ariaAttachmentService.buildAttachmentBlocks([
      att({ kind: "image", mimeType: "image/png" }),
    ])) as Array<{
      type: string;
      source: { media_type: string; data: string };
    }>;
    expect(block.type).toBe("image");
    expect(block.source.media_type).toBe("image/png");
    expect(block.source.data).toBe(Buffer.from("IMG").toString("base64"));
  });

  it("builds a text block from a PDF's Gemini-extracted text (no download)", async () => {
    // PDFs are extracted to text at upload (SDK 0.32.1 has no stable PDF
    // document block), so the chat turn sends text, not a binary block.
    const spy = vi.spyOn(storage, "downloadToBuffer");
    const [block] = (await ariaAttachmentService.buildAttachmentBlocks([
      att({
        kind: "document",
        mimeType: "application/pdf",
        name: "report.pdf",
        extractedText: "quarterly revenue was up",
      }),
    ])) as Array<{ type: string; text: string }>;
    expect(block.type).toBe("text");
    expect(block.text).toContain("report.pdf");
    expect(block.text).toContain("quarterly revenue was up");
    expect(spy).not.toHaveBeenCalled();
  });

  it("builds a text block from extracted text (no download)", async () => {
    const spy = vi.spyOn(storage, "downloadToBuffer");
    const [block] = (await ariaAttachmentService.buildAttachmentBlocks([
      att({
        kind: "document",
        mimeType: "text/plain",
        name: "notes.txt",
        extractedText: "hello world",
      }),
    ])) as Array<{ type: string; text: string }>;
    expect(block.type).toBe("text");
    expect(block.text).toContain("notes.txt");
    expect(block.text).toContain("hello world");
    expect(spy).not.toHaveBeenCalled();
  });

  it("degrades to a text note when the download fails", async () => {
    vi.spyOn(storage, "downloadToBuffer").mockRejectedValue(new Error("gone"));
    const [block] = (await ariaAttachmentService.buildAttachmentBlocks([
      att({ kind: "image", mimeType: "image/png", name: "x.png" }),
    ])) as Array<{ type: string; text: string }>;
    expect(block.type).toBe("text");
    expect(block.text).toContain("could not be loaded");
  });
});
