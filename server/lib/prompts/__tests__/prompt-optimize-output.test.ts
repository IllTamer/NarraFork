/**
 * The text fallback for prompt optimization.
 *
 * These tests pin the packaging rules: thinking blocks, fences and preambles are
 * removed, while anything in the middle of the payload — including the user's
 * own fenced content and multi-segment markers — must survive untouched.
 */
import { describe, expect, test } from "bun:test";
import { normalizeOptimizedPrompt } from "../prompt-optimize-output";

const ORIGINAL = "帮我写一个登录页面";

describe("thinking removal", () => {
	test("strips a complete reasoning block and keeps the prompt", () => {
		const raw =
			"<thinking>用户想要一个登录页，我应该补充细节。</thinking>\n写一个登录页面，包含邮箱和密码字段。";
		expect(normalizeOptimizedPrompt(raw, ORIGINAL)).toBe("写一个登录页面，包含邮箱和密码字段。");
	});

	test("strips a bare reasoning tag block", () => {
		const raw = "<reasoning>hmm</reasoning>写一个登录页面。";
		expect(normalizeOptimizedPrompt(raw, ORIGINAL)).toBe("写一个登录页面。");
	});

	test("an unclosed thinking tag drops the unterminated tail", () => {
		// A model that opens a thinking block and never closes it ended the turn
		// inside its own reasoning; nothing after the tag is prompt text.
		const raw = "写一个登录页面。\n<thinking>我先考虑一下字段";
		expect(normalizeOptimizedPrompt(raw, ORIGINAL)).toBe("写一个登录页面。");
	});

	test("a response that is only a thinking block falls back to the draft", () => {
		const raw = "<thinking>nothing useful produced</thinking>";
		expect(normalizeOptimizedPrompt(raw, ORIGINAL)).toBe(ORIGINAL);
	});
});

describe("fence extraction", () => {
	test("unwraps a fence that encloses the whole payload", () => {
		const raw = "```text\n写一个登录页面。\n```";
		expect(normalizeOptimizedPrompt(raw, ORIGINAL)).toBe("写一个登录页面。");
	});

	test("takes the first complete fence when a preamble precedes it", () => {
		const raw =
			"Here is the optimized prompt:\n\n```markdown\n写一个登录页面。\n```\n\nLet me know!";
		expect(normalizeOptimizedPrompt(raw, ORIGINAL)).toBe("写一个登录页面。");
	});

	test("ignores an unterminated fence and keeps the text", () => {
		const raw = "写一个登录页面。\n```";
		expect(normalizeOptimizedPrompt(raw, ORIGINAL)).toBe("写一个登录页面。\n```");
	});
});

describe("preamble removal", () => {
	test("drops an English label line", () => {
		const raw = "Optimized prompt:\n写一个登录页面，包含表单校验。";
		expect(normalizeOptimizedPrompt(raw, ORIGINAL)).toBe("写一个登录页面，包含表单校验。");
	});

	test("drops a Chinese label line", () => {
		const raw = "优化后的提示词：\n写一个登录页面，包含表单校验。";
		expect(normalizeOptimizedPrompt(raw, ORIGINAL)).toBe("写一个登录页面，包含表单校验。");
	});

	test("drops a bolded label line", () => {
		const raw = "**优化后的提示词：**\n写一个登录页面，包含表单校验。";
		expect(normalizeOptimizedPrompt(raw, ORIGINAL)).toBe("写一个登录页面，包含表单校验。");
	});

	test("keeps a colon line the draft itself starts with", () => {
		// The draft's own first line is `需求：`, so a model echoing it back is
		// reproducing user content, not adding a preamble.
		const draft = "需求：\n做一个登录页面";
		const raw = "需求：\n做一个登录页面，含表单校验。";
		expect(normalizeOptimizedPrompt(raw, draft)).toBe("需求：\n做一个登录页面，含表单校验。");
	});

	test("keeps a colon line when nothing follows it", () => {
		const raw = "写一个登录页面：";
		expect(normalizeOptimizedPrompt(raw, ORIGINAL)).toBe("写一个登录页面：");
	});
});

describe("wrapping cleanup", () => {
	test("strips wrapping quotes", () => {
		expect(normalizeOptimizedPrompt('"写一个登录页面。"', ORIGINAL)).toBe("写一个登录页面。");
	});

	test("returns the draft when nothing survives cleaning", () => {
		expect(normalizeOptimizedPrompt("   ", ORIGINAL)).toBe(ORIGINAL);
	});

	test("returns the draft for an empty reply", () => {
		expect(normalizeOptimizedPrompt("", ORIGINAL)).toBe(ORIGINAL);
	});
});

describe("multi-segment drafts", () => {
	const draft =
		"<<<NF_a_0>>>\n写个登录页\n<<<NF_a_0_END>>>\n<<<NF_a_1>>>\n加校验\n<<<NF_a_1_END>>>";

	test("preserves marker lines exactly", () => {
		const raw =
			"<<<NF_a_0>>>\n写一个登录页面\n<<<NF_a_0_END>>>\n<<<NF_a_1>>>\n补充表单校验\n<<<NF_a_1_END>>>";
		expect(normalizeOptimizedPrompt(raw, draft)).toBe(raw);
	});

	test("does not extract a fence that is inside a segment", () => {
		// A fenced block here is the user's own content; extracting it would
		// destroy the markers the client parses.
		const raw =
			"<<<NF_a_0>>>\n```sql\nSELECT 1\n```\n<<<NF_a_0_END>>>\n<<<NF_a_1>>>\n补充表单校验\n<<<NF_a_1_END>>>";
		expect(normalizeOptimizedPrompt(raw, draft)).toBe(raw);
	});

	test("still strips a thinking block around segmented output", () => {
		const raw =
			"<thinking>分段处理</thinking>\n<<<NF_a_0>>>\n写一个登录页面\n<<<NF_a_0_END>>>\n<<<NF_a_1>>>\n补充表单校验\n<<<NF_a_1_END>>>";
		expect(normalizeOptimizedPrompt(raw, draft)).toBe(
			"<<<NF_a_0>>>\n写一个登录页面\n<<<NF_a_0_END>>>\n<<<NF_a_1>>>\n补充表单校验\n<<<NF_a_1_END>>>",
		);
	});
});
