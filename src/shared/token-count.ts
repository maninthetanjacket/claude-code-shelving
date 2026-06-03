/**
 * Token estimation shared by the MCP compress preview and the find-arc CLI.
 *
 * The base count uses a real BPE tokenizer (gpt-tokenizer, o200k_base) instead
 * of a chars/N heuristic. Shelving content is dominated by tool_use inputs and
 * tool_result bodies — JSON, file paths, bash output, hyphenated hex UUIDs —
 * which tokenize far denser than prose, so the old Math.ceil(chars / 4) ran
 * ~2x low on realistic ranges.
 *
 * But a raw o200k count of the extracted text is still not the number we want:
 * we are estimating how much *Claude* context a range occupies, and that
 * diverges from o200k for two measured reasons. Calibrating o200k message
 * tokens against real Anthropic `input_tokens` across ~60 captured requests
 * (two-variable least squares, R^2 ≈ 0.94) gives:
 *
 *   real_input ≈ 29_782 + 1.42 * o200k(content) + 0.28 * o200k(signature)
 *
 *   - CONTENT_CALIBRATION (1.42): Claude's tokenizer is ~1.4x denser than
 *     o200k on this content mix (prose + code + JSON).
 *   - SIGNATURE_CALIBRATION (0.28): extended-thinking blocks carry an encrypted
 *     `signature` (a large base64 blob, present in every replayed request).
 *     It is billed as input, but only ~28% of its base64 token-length lands.
 *     The signature also happens to be an excellent proxy for the *hidden* raw
 *     reasoning behind a turn (it scales with it, r ≈ 0.96), which is why it
 *     carries real input weight even though the visible thinking is a summary.
 *   - The 29_782 intercept is fixed overhead (system prompt + tool schemas).
 *     It is deliberately NOT applied here: the estimator reports the *marginal*
 *     tokens a range occupies, and shelving conversation turns never reclaims
 *     the system/tools prefix.
 *
 * Caveat: these coefficients were fit on one session (fixed tool config, one
 * model). 1.42 (tokenizer density) should generalize; 0.28 (an Anthropic-
 * internal billing/encoding artifact) may drift. Both are isolated here so
 * they are trivial to re-measure and retune.
 */
import { encode } from "gpt-tokenizer/encoding/o200k_base";

/** Claude-vs-o200k tokenizer density on real message content. See file header. */
export const CONTENT_CALIBRATION = 1.42;

/** Fraction of a thinking block's base64 signature billed as input. See header. */
export const SIGNATURE_CALIBRATION = 0.28;

/** Token count for an arbitrary string. */
export function countTextTokens(text: string): number {
  if (!text) return 0;
  return encode(text).length;
}

/**
 * Calibrated estimate of the Claude input tokens one message's content
 * occupies: content tokens scaled to Claude's density, plus the billed
 * fraction of any extended-thinking signature.
 */
export function countContentTokens(content: string | unknown[]): number {
  const contentTokens = countTextTokens(messageContentToString(content));
  const signatureTokens = countTextTokens(messageSignaturesToString(content));
  return Math.round(
    CONTENT_CALIBRATION * contentTokens + SIGNATURE_CALIBRATION * signatureTokens,
  );
}

/**
 * Concatenate the encrypted `signature` payloads of any thinking blocks in a
 * message's content. These are not part of messageContentToString (which feeds
 * previews) but are billed as input, so they are counted separately.
 */
export function messageSignaturesToString(content: string | unknown[]): string {
  if (!Array.isArray(content)) return "";
  const sigs: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const block = item as Record<string, unknown>;
    if (block["type"] === "thinking" && typeof block["signature"] === "string") {
      sigs.push(block["signature"]);
    }
  }
  return sigs.join("\n");
}

/**
 * Flatten a message's content into a single string, covering every block type
 * that carries tokens: text, thinking, tool_use (name + JSON input), and
 * tool_result (string or nested text/blocks). Also used for preview snippets.
 */
export function messageContentToString(content: string | unknown[]): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map(contentBlockToString)
      .filter((item) => item.length > 0)
      .join("\n");
  }
  return "";
}

function contentBlockToString(item: unknown): string {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return "";

  const block = item as Record<string, unknown>;
  if (typeof block["text"] === "string") {
    return block["text"];
  }

  if (block["type"] === "thinking" && typeof block["thinking"] === "string") {
    return block["thinking"];
  }

  if (block["type"] === "tool_use") {
    const parts: string[] = [];
    if (typeof block["name"] === "string") parts.push(block["name"]);
    if (block["input"] !== undefined) parts.push(stableStringify(block["input"]));
    return parts.join("\n");
  }

  if (block["type"] === "tool_result") {
    const content = block["content"];
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map(contentBlockToString)
        .filter((part) => part.length > 0)
        .join("\n");
    }
    if (content && typeof content === "object") {
      return contentBlockToString(content);
    }
    return "";
  }

  return "";
}

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
