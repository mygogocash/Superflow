import {
  createPartFromBase64,
  createPartFromText,
  createPartFromUri,
  createUserContent,
} from "@google/genai";
import type { ManutAiAttachment } from "@nexora/database";
import { OfficeParser } from "officeparser";
import * as XLSX from "xlsx";

import { BadRequestException } from "@/common/exceptions/http-exception";
import { logger } from "@/common/utils/logger";
import { GEMINI_MODELS, getGeminiClient } from "@/infrastructure/ai/gemini";
import {
  downloadToBuffer,
  STORAGE_BUCKETS,
  uploadFile,
} from "@/infrastructure/storage/supabase-storage";
import { ariaRepository } from "@/modules/aria/aria.repository";

// Supported kinds: Claude-native images, PDF (Gemini-extracted), plain-text
// docs, Office docs (docx/xlsx/pptx, extracted server-side), and video/audio
// (Gemini-transcribed). Anything else is rejected with a clear message rather
// than silently accepted.
const IMAGE_MIMES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
]);
const PDF_MIME = "application/pdf";
const TEXT_MIMES = new Set([
  "text/plain",
  "text/csv",
  "text/markdown",
  "text/x-markdown",
]);
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX_MIME =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const OFFICE_MIMES = new Set([DOCX_MIME, XLSX_MIME, PPTX_MIME]);
// Video + audio: Claude can't watch/listen, so we transcribe with Gemini
// (native A/V) at upload and feed Claude the transcript as text.
const AV_MIMES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-matroska",
  "audio/mp4",
  "audio/mpeg",
  "audio/wav",
  "audio/webm",
]);

// Per-kind caps. Images/PDFs are sent to Claude, so honour its input
// limits (≈5MB/image, 32MB/PDF). Text + Office are extracted server-side.
// Video/audio is transcribed via Gemini in the upload request, so cap it
// so the request stays within the Cloud Run timeout + instance memory.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PDF_BYTES = 32 * 1024 * 1024;
const MAX_TEXT_BYTES = 5 * 1024 * 1024;
const MAX_OFFICE_BYTES = 15 * 1024 * 1024;
const MAX_AV_BYTES = 50 * 1024 * 1024;

// Multer's hard limit for the upload endpoint = the largest per-kind cap.
export const ARIA_ATTACHMENT_MAX_BYTES = MAX_AV_BYTES;
export const ARIA_MAX_ATTACHMENTS_PER_MESSAGE = 10;

type AttachmentPlan =
  | { kind: "image"; mediaType: string; cap: number }
  | { kind: "document-pdf"; cap: number }
  | { kind: "document-text"; cap: number }
  | { kind: "document-office"; cap: number }
  | { kind: "video"; cap: number };

function planFor(mimeType: string): AttachmentPlan | null {
  const mime = mimeType.trim().toLowerCase();
  if (IMAGE_MIMES.has(mime)) {
    return {
      kind: "image",
      mediaType: mime === "image/jpg" ? "image/jpeg" : mime,
      cap: MAX_IMAGE_BYTES,
    };
  }
  if (mime === PDF_MIME) return { kind: "document-pdf", cap: MAX_PDF_BYTES };
  if (TEXT_MIMES.has(mime)) {
    return { kind: "document-text", cap: MAX_TEXT_BYTES };
  }
  if (OFFICE_MIMES.has(mime)) {
    return { kind: "document-office", cap: MAX_OFFICE_BYTES };
  }
  if (AV_MIMES.has(mime)) {
    return { kind: "video", cap: MAX_AV_BYTES };
  }
  return null;
}

/**
 * Validate + store one ARIA chat attachment (upload-first). Images/PDFs are
 * kept raw for later vision/document blocks; text docs are decoded now and
 * cached in `extractedText` so chat turns don't re-read the file. The row is
 * created unlinked (messageId null) and bound to a message when the user sends.
 */
async function uploadAttachment(
  userId: string,
  file: {
    buffer: Buffer;
    originalName: string;
    mimeType: string;
    size: number;
  },
): Promise<ManutAiAttachment> {
  const plan = planFor(file.mimeType);
  if (!plan) {
    throw new BadRequestException(
      `Unsupported file type "${file.mimeType}". Manut AI accepts images (JPEG/PNG/WebP), PDF, text files (.txt/.csv/.md), Office docs (.docx/.xlsx/.pptx), and video/audio (.mp4/.mov/.webm/.m4a).`,
    );
  }
  if (file.size > plan.cap) {
    throw new BadRequestException(
      `File is too large (${Math.round(file.size / 1024 / 1024)}MB). Max ${Math.round(plan.cap / 1024 / 1024)}MB for this type.`,
    );
  }

  const bucket = STORAGE_BUCKETS.DOCUMENTS;
  const { path } = await uploadFile(bucket, userId, {
    buffer: file.buffer,
    originalName: file.originalName,
    mimeType: file.mimeType,
    size: file.size,
  });

  let extractedText: string | null = null;
  if (plan.kind === "document-text") {
    extractedText = file.buffer.toString("utf8");
  } else if (plan.kind === "document-pdf") {
    // The installed @anthropic-ai/sdk (0.32.1) exposes PDF `document` blocks
    // only under the beta namespace, so the stable messages stream ARIA uses
    // can't send them. Extract the text with Gemini (which reads PDFs — incl.
    // scanned ones — natively) at upload and feed it to Claude as text.
    extractedText = await extractPdfText(file.buffer);
  } else if (plan.kind === "document-office") {
    extractedText = await extractOfficeText(file.buffer, file.mimeType);
  } else if (plan.kind === "video") {
    extractedText = await transcribeAv(file.buffer, file.mimeType);
  }

  // A PDF/Office/video whose text couldn't be extracted/transcribed is stored
  // but unusable by the model — mark it failed so the UI can flag it rather
  // than implying ARIA read it.
  const status =
    (plan.kind === "document-pdf" ||
      plan.kind === "document-office" ||
      plan.kind === "video") &&
    extractedText == null
      ? "failed"
      : "ready";

  return ariaRepository.createAttachment({
    userId,
    kind:
      plan.kind === "image"
        ? "image"
        : plan.kind === "video"
          ? "video"
          : "document",
    name: file.originalName,
    mimeType: file.mimeType,
    size: file.size,
    storageBucket: bucket,
    storagePath: path,
    extractedText,
    status,
  });
}

/**
 * Extract the text of a PDF via Gemini (handles digital + scanned PDFs). A
 * failure degrades to null (the chat turn then notes the file couldn't be
 * read) rather than blocking the upload.
 */
async function extractPdfText(buffer: Buffer): Promise<string | null> {
  try {
    const gemini = getGeminiClient();
    const res = await gemini.models.generateContent({
      model: GEMINI_MODELS.FLASH,
      contents: [
        createUserContent([
          createPartFromBase64(buffer.toString("base64"), "application/pdf"),
          createPartFromText(
            "Extract ALL text from this PDF verbatim, preserving reading order and table structure as plain text. Output only the extracted text.",
          ),
        ]),
      ],
      config: { maxOutputTokens: 8192, temperature: 0 },
    });
    const text = res.text?.trim();
    return text && text.length > 0 ? text : null;
  } catch (err) {
    logger.error("ARIA PDF text extraction failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Extract text from an Office document. Spreadsheets go through SheetJS
 * (per-sheet CSV keeps tabular structure legible to the model); Word/
 * PowerPoint go through officeparser's plain-text AST. Failure → null (the
 * chat turn then notes the file couldn't be read).
 */
async function extractOfficeText(
  buffer: Buffer,
  mimeType: string,
): Promise<string | null> {
  try {
    if (mimeType.toLowerCase() === XLSX_MIME) {
      const wb = XLSX.read(buffer, { type: "buffer" });
      const parts = wb.SheetNames.map((name) => {
        const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]!);
        return csv.trim() ? `# Sheet: ${name}\n${csv.trim()}` : "";
      }).filter(Boolean);
      const text = parts.join("\n\n").trim();
      return text.length > 0 ? text : null;
    }
    const ast = await OfficeParser.parseOffice(buffer);
    const text = ast.toText().trim();
    return text.length > 0 ? text : null;
  } catch (err) {
    logger.error("ARIA Office text extraction failed", {
      mimeType,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// How long we wait for Gemini to finish ingesting the uploaded A/V file
// before its state flips ACTIVE. Bounds the upload request so a very long
// clip fails cleanly instead of hanging past the Cloud Run timeout.
const AV_ACTIVE_POLL_MS = 3000;
const AV_ACTIVE_MAX_POLLS = 30; // ~90s

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Transcribe a video/audio file with Gemini (Claude has no A/V input). Uses
 * the Gemini Files API (handles files past the inline-request limit): upload,
 * wait for the file to become ACTIVE, then ask for a verbatim transcript.
 * Failure / timeout → null (the attachment is then marked failed).
 */
async function transcribeAv(
  buffer: Buffer,
  mimeType: string,
): Promise<string | null> {
  const gemini = getGeminiClient();
  let uploadedName: string | undefined;
  try {
    const blob = new Blob([buffer], { type: mimeType });
    let uploaded = await gemini.files.upload({
      file: blob,
      config: { mimeType },
    });
    uploadedName = uploaded.name;

    for (
      let i = 0;
      i < AV_ACTIVE_MAX_POLLS && uploaded.state === "PROCESSING";
      i++
    ) {
      await sleep(AV_ACTIVE_POLL_MS);
      uploaded = await gemini.files.get({ name: uploaded.name! });
    }
    if (uploaded.state !== "ACTIVE" || !uploaded.uri) {
      logger.warn("ARIA A/V transcription: file not ACTIVE in time", {
        state: uploaded.state,
      });
      return null;
    }

    const res = await gemini.models.generateContent({
      model: GEMINI_MODELS.FLASH,
      contents: [
        createUserContent([
          createPartFromUri(uploaded.uri, mimeType),
          createPartFromText(
            "Transcribe all spoken audio in this file verbatim. Note distinct speakers as 'Speaker 1/2/…' when discernible. Output only the transcript text.",
          ),
        ]),
      ],
      config: { maxOutputTokens: 8192, temperature: 0 },
    });
    const text = res.text?.trim();
    return text && text.length > 0 ? text : null;
  } catch (err) {
    logger.error("ARIA A/V transcription failed", {
      mimeType,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    // Best-effort cleanup of the temporary Gemini file.
    if (uploadedName) {
      try {
        await gemini.files.delete({ name: uploadedName });
      } catch {
        /* ignore */
      }
    }
  }
}

// Cap on extracted-text length fed to the model so a huge CSV/txt can't
// blow the context window. Truncation is flagged so the model knows.
const MAX_EXTRACTED_TEXT_CHARS = 40_000;

/**
 * Turn a message's attachments into Anthropic content blocks. Images →
 * base64 image blocks; PDFs → base64 document blocks; text docs (and, later,
 * video transcripts) → text blocks with the extracted content. Bytes are
 * fetched from the private bucket per turn. A failed fetch degrades to a
 * text note rather than aborting the whole chat turn.
 */
async function buildAttachmentBlocks(
  attachments: ManutAiAttachment[],
  opts: { inlineImages?: boolean } = {},
): Promise<unknown[]> {
  const inlineImages = opts.inlineImages ?? true;
  const blocks: unknown[] = [];
  for (const att of attachments) {
    try {
      if (att.kind === "image") {
        // Images are re-sent to the model each turn they stay in the
        // window — costly. Only inline the bytes for recent turns; older
        // ones degrade to a text note so the model still knows a picture
        // was shared, without re-uploading it every turn.
        if (!inlineImages) {
          blocks.push({
            type: "text",
            text: `[Image "${att.name}" shared earlier in this conversation]`,
          });
          continue;
        }
        const { buffer } = await downloadToBuffer(
          att.storageBucket,
          att.storagePath,
        );
        blocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type:
              att.mimeType.toLowerCase() === "image/jpg"
                ? "image/jpeg"
                : att.mimeType.toLowerCase(),
            data: buffer.toString("base64"),
          },
        });
      } else if (att.extractedText != null) {
        const body =
          att.extractedText.length > MAX_EXTRACTED_TEXT_CHARS
            ? `${att.extractedText.slice(0, MAX_EXTRACTED_TEXT_CHARS)}\n…(truncated)`
            : att.extractedText;
        const label =
          att.kind === "video"
            ? `[Transcript of "${att.name}"]`
            : `[Attached file "${att.name}"]`;
        blocks.push({ type: "text", text: `${label}\n${body}` });
      } else {
        blocks.push({
          type: "text",
          text: `[Attached file "${att.name}" (${att.mimeType}) — content not available]`,
        });
      }
    } catch (err) {
      logger.error("ARIA attachment block build failed", {
        attachmentId: att.id,
        error: err instanceof Error ? err.message : String(err),
      });
      blocks.push({
        type: "text",
        text: `[Attached file "${att.name}" could not be loaded]`,
      });
    }
  }
  return blocks;
}

export const ariaAttachmentService = {
  uploadAttachment,
  buildAttachmentBlocks,
};
