/**
 * Text fallback for prompt optimization output.
 *
 * This runs when structured output was not available (adapter has no native
 * JSON-Schema mode, the relay rejected the parameter, or the model answered with
 * prose anyway). Its job is to recover *just* the optimized prompt from a model
 * reply that may carry packaging around it: a thinking block, a fenced code
 * block, or a one-line "here is your prompt:" preamble.
 *
 * Invariant: cleaning only ever touches the *leading* and *wrapping* layers.
 * It never rewrites, reorders or removes anything in the middle of the payload,
 * because the payload is the user's own prompt text and the whole point of the
 * feature is to return it intact.
 */

/** Segment markers used by multi-segment drafts; see the optimize route. */
const SEGMENT_MARKER = /<<<NF_[^>\n]+>>>/;

/**
 * Thinking containers models wrap private reasoning in when a provider surfaces
 * them inline instead of on a separate reasoning channel. `deepseek-r1`-style
 * output uses the bare tag form (`reasoning`), Claude-style output the angle form.
 */
const COMPLETE_THINKING_BLOCK = /<(thinking|think|reasoning)>[\s\S]*?<\/\1\s*>/gi;
const OPENING_THINKING_TAG = /<(thinking|think|reasoning)>/i;

/** A preamble line such as `Optimized prompt:` / `优化后的提示词：`. */
const TRAILING_COLON = /[:：]\s*$/;
/** Markdown emphasis a model may wrap the preamble label in. */
const WRAPPING_EMPHASIS = /^(\*\*|__|\*|_)(.*?)\1$/;
const MAX_PREAMBLE_LINES = 1;
const MAX_PREAMBLE_LENGTH = 80;

/**
 * Remove `<thinking>` / `reasoning` wrappers and their contents.
 *
 * Complete blocks are removed wherever they appear. An *unclosed* opening tag is
 * treated as a truncation signal: everything from that tag to the end is
 * discarded, because a model that started a thinking block and never closed it
 * almost always ended the turn inside its own reasoning.
 */
function stripThinkingBlocks(text: string): string {
	let result = text.replace(COMPLETE_THINKING_BLOCK, "");
	const unclosed = OPENING_THINKING_TAG.exec(result);
	if (unclosed) {
		// Drop the tag and everything after it: the remainder is unterminated
		// private reasoning, not prompt text.
		result = result.slice(0, unclosed.index);
	}
	return result;
}

/**
 * Extract the contents of the first *complete* fenced block, if the payload has
 * one. Returns `null` when there is no complete fence or its body is empty.
 *
 * Only called when the payload contains no segment markers, where a fence can
 * only be packaging. Inside a multi-segment draft a fence may be the user's own
 * content, so extraction is not safe there.
 */
function extractFirstFencedBlock(text: string): string | null {
	const open = text.indexOf("```");
	if (open === -1) return null;
	const bodyStart = text.indexOf("\n", open);
	if (bodyStart === -1) return null;
	const close = text.indexOf("```", bodyStart);
	if (close === -1) return null;
	const body = text.slice(bodyStart + 1, close).trim();
	return body || null;
}

/**
 * Strip a single leading label line such as `Optimized prompt:`.
 *
 * Conservative on purpose — the draft itself is user text and may legitimately
 * begin with a colon-terminated line (`需求：`). The line is removed only when all
 * of the following hold, which together make "this is a model preamble" far more
 * likely than "this is the user's own first line":
 *
 *  1. it is the first line,
 *  2. it is a single short line ending in `:` / `：`,
 *  3. something follows it,
 *  4. the original draft does not itself start with that same line.
 */
function stripLeadingPreamble(text: string, original: string): string {
	const lines = text.split("\n");
	if (lines.length <= MAX_PREAMBLE_LINES) return text;

	const rawLabel = lines[0].trim();
	if (!rawLabel || rawLabel.length > MAX_PREAMBLE_LENGTH) return text;
	// Models often bold the label (`**Optimized prompt:**`); unwrap before testing
	// for the colon so the emphasis does not hide it.
	const unwrapped = rawLabel.replace(WRAPPING_EMPHASIS, "$2").trim();
	if (!TRAILING_COLON.test(unwrapped)) return text;

	const remainder = lines.slice(MAX_PREAMBLE_LINES).join("\n").trim();
	if (!remainder) return text;
	// The draft legitimately starts with this same line: keep it.
	if (original.trimStart().startsWith(rawLabel)) return text;

	return remainder;
}

/** Strip a single pair of wrapping quotes, as before structured output existed. */
function stripWrappingQuotes(text: string): string {
	if (text.length < 2) return text;
	const first = text[0];
	const last = text[text.length - 1];
	if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
		return text.slice(1, -1).trim();
	}
	return text;
}

/** Strip a fence that wraps the entire payload (leaving inner fences alone). */
function stripWrappingFence(text: string): string {
	if (!text.startsWith("```") || !text.endsWith("```")) return text;
	const lines = text.split("\n");
	if (lines.length <= 2) return text;
	return lines.slice(1, -1).join("\n").trim();
}

/**
 * Normalize a raw optimize reply into the text that may be written to the
 * composer, falling back to `original` when nothing usable survives.
 *
 * The same function processes both the structured and the text path so the two
 * cannot drift: structured output merely starts from an already-clean string.
 */
export function normalizeOptimizedPrompt(raw: string, original: string): string {
	const hasSegments = SEGMENT_MARKER.test(raw);

	let result = stripThinkingBlocks(raw).trim();

	// Packaging removal is only safe when the payload is a single prompt. With
	// segment markers the payload is a framed document the client parses, so
	// markers, fences and colon lines may all be load-bearing content.
	if (!hasSegments) {
		const fenced = extractFirstFencedBlock(result);
		if (fenced) result = fenced;
		result = stripLeadingPreamble(result, original);
	}

	result = stripWrappingQuotes(result.trim());
	result = stripWrappingFence(result).trim();

	return result || original;
}
