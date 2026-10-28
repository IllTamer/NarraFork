/**
 * Text-instruction fallback for relays that ignore a native structured-output
 * constraint.
 *
 * Native `json_schema` / `text.format` is the first choice and is left alone
 * wherever it works. This file pins the downgrade: a relay that has already
 * proven it drops the constraint is asked for JSON in the instruction instead,
 * and the reply is parsed with the same tolerant parser — every field survives,
 * only the *guarantee* is gone.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { OpenAIProvider } from "../openai-provider";
import type { ResponseFormat } from "../provider";
import {
	modelLacksNativeStructuredOutput,
	rememberMissingNativeStructuredOutput,
	renderSchemaInstruction,
	resetStructuredOutputFallbackMemory,
	structuredOutputRelayKey,
	withSchemaInstruction,
} from "../structured-output-fallback";

const FORMAT: ResponseFormat = {
	type: "json_schema",
	name: "prompt_optimize_result",
	schema: {
		type: "object",
		properties: {
			optimizedPrompt: { type: "string" },
			reasoningSummary: { type: "string" },
		},
		required: ["optimizedPrompt", "reasoningSummary"],
		additionalProperties: false,
	},
	strict: true,
	summaryField: "reasoningSummary",
};

const WITH_SUMMARY =
	'{"optimizedPrompt":"写一个登录页面。","reasoningSummary":"补充了字段与校验。"}';

/** The relay under test: a known-bad upstream, distinct from other test files. */
const RELAY_MODEL = "geek2api:deepseek-v4.1-flash";

/**
 * Capability is learned per (apiMode, model): the two endpoints carry different
 * fields, and a relay may implement one while dropping the other.
 */
const CHAT_KEY = structuredOutputRelayKey("completions", RELAY_MODEL);
const RESPONSES_KEY = structuredOutputRelayKey("responses", RELAY_MODEL);

type Captured = { url: string; body: Record<string, unknown> };

async function drive<T>(
	provider: OpenAIProvider,
	body: string,
	run: (provider: OpenAIProvider) => Promise<T>,
	contentType = "text/event-stream",
): Promise<{ request: Captured; result: T }> {
	let captured: Captured | undefined;
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
		captured = {
			url: String(input),
			body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
		};
		return new Response(body, { status: 200, headers: { "content-type": contentType } });
		// biome-ignore lint/suspicious/noExplicitAny: fetch stub
	}) as any;
	try {
		const result = await run(provider);
		return { request: captured as Captured, result };
	} finally {
		globalThis.fetch = realFetch;
	}
}

const chatSse = (content: string) =>
	[
		`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
		`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
		"data: [DONE]\n\n",
	].join("");

const responsesSse = (chunks: string[]) =>
	[
		...chunks.map(
			(delta) =>
				`event: response.output_text.delta\ndata: ${JSON.stringify({
					type: "response.output_text.delta",
					delta,
				})}\n\n`,
		),
		`event: response.completed\ndata: ${JSON.stringify({
			type: "response.completed",
			response: { status: "completed", output: [] },
		})}\n\n`,
	].join("");

const chatProvider = () =>
	new OpenAIProvider({
		name: "relay",
		prefix: "geek2api",
		apiKey: "sk-test",
		apiMode: "completions",
		baseUrl: "https://relay.test/v1",
		// biome-ignore lint/suspicious/noExplicitAny: test config subset
	} as any);

const responsesProvider = () =>
	new OpenAIProvider({
		name: "relay",
		prefix: "geek2api",
		apiKey: "sk-test",
		apiMode: "responses",
		baseUrl: "https://relay.test/v1",
		// biome-ignore lint/suspicious/noExplicitAny: test config subset
	} as any);

beforeEach(() => {
	resetStructuredOutputFallbackMemory();
});

describe("learned relay memory", () => {
	test("nothing is downgraded before a failure is observed", () => {
		expect(modelLacksNativeStructuredOutput(CHAT_KEY)).toBe(false);
	});

	test("a failure is remembered per model", () => {
		rememberMissingNativeStructuredOutput(CHAT_KEY);
		expect(modelLacksNativeStructuredOutput(CHAT_KEY)).toBe(true);
		// Knowledge is per relay/model: a different upstream is untouched.
		expect(
			modelLacksNativeStructuredOutput(structuredOutputRelayKey("completions", "openai:gpt-5")),
		).toBe(false);
	});

	test("remembering the same model twice is idempotent", () => {
		rememberMissingNativeStructuredOutput(CHAT_KEY);
		rememberMissingNativeStructuredOutput(CHAT_KEY);
		expect(modelLacksNativeStructuredOutput(CHAT_KEY)).toBe(true);
	});
});

describe("schema instruction rendering", () => {
	test("serializes the actual schema, not a summary of it", () => {
		const instruction = renderSchemaInstruction(FORMAT);
		// The model must see the real field names and the required list.
		expect(instruction).toContain("optimizedPrompt");
		expect(instruction).toContain("reasoningSummary");
		expect(instruction).toContain('"required"');
		// and it must be told the output shape unambiguously.
		expect(instruction.toLowerCase()).toContain("json only");
		expect(instruction).toContain("no markdown");
	});

	test("appends to the caller's instruction instead of replacing it", () => {
		const merged = withSchemaInstruction("你是提示词优化器。", FORMAT);
		expect(merged.startsWith("你是提示词优化器。")).toBe(true);
		expect(merged).toContain("optimizedPrompt");
	});

	test("works when the caller has no system instruction at all", () => {
		const merged = withSchemaInstruction(undefined, FORMAT);
		expect(merged.startsWith("\n")).toBe(false);
		expect(merged).toContain("optimizedPrompt");
	});
});

describe("chat completions downgrade", () => {
	test("a known-bad relay gets the schema in the system message, not response_format", async () => {
		rememberMissingNativeStructuredOutput(CHAT_KEY);
		const { request, result } = await drive(chatProvider(), chatSse(WITH_SUMMARY), (provider) =>
			provider.generateWithMeta("draft", RELAY_MODEL, "sys", { responseFormat: FORMAT }),
		);

		expect(request.body).not.toHaveProperty("response_format");
		const messages = request.body.messages as Array<{ role: string; content: string }>;
		expect(messages[0].role).toBe("system");
		expect(messages[0].content).toContain("optimizedPrompt");
		// The caller's own instruction survives the merge.
		expect(messages[0].content.startsWith("sys")).toBe(true);

		// And the reply is still parsed into the same fields.
		expect(result.structured).toEqual({
			optimizedPrompt: "写一个登录页面。",
			reasoningSummary: "补充了字段与校验。",
		});
		expect(result.reasoningSummary).toBe("补充了字段与校验。");
		// Nothing was reported as degraded: the text path honoured the contract.
		expect(result.responseFormatDegraded).toBeUndefined();
	});

	test("a relay that ignores the instruction still degrades honestly", async () => {
		rememberMissingNativeStructuredOutput(CHAT_KEY);
		const { result } = await drive(chatProvider(), chatSse("Here is your prompt."), (provider) =>
			provider.generateWithMeta("draft", RELAY_MODEL, "sys", { responseFormat: FORMAT }),
		);
		expect(result.structured).toBeUndefined();
		expect(result.reasoningSummary).toBeUndefined();
		expect(result.responseFormatDegraded).toContain("OpenAI");
	});

	test("a supported upstream keeps the native constraint", async () => {
		const { request } = await drive(chatProvider(), chatSse(WITH_SUMMARY), (provider) =>
			provider.generateWithMeta("draft", "openai:gpt-5", "sys", { responseFormat: FORMAT }),
		);
		expect(request.body.response_format).toEqual({
			type: "json_schema",
			json_schema: { name: "prompt_optimize_result", schema: FORMAT.schema, strict: true },
		});
		const messages = request.body.messages as Array<{ role: string; content: string }>;
		// The system instruction is left exactly as the caller wrote it.
		expect(messages[0].content).toBe("sys");
	});
});

describe("OpenAI Responses downgrade", () => {
	test("a known-bad relay gets the schema in instructions, not text.format", async () => {
		rememberMissingNativeStructuredOutput(RESPONSES_KEY);
		const { request, result } = await drive(
			responsesProvider(),
			responsesSse([WITH_SUMMARY]),
			(provider) =>
				provider.generateWithMeta("draft", RELAY_MODEL, "sys", { responseFormat: FORMAT }),
		);

		// This is the case observed against the geek2api relay: it accepted
		// `text.format`, answered in prose, and the summary silently vanished.
		expect(request.body).not.toHaveProperty("text");
		expect(request.body).not.toHaveProperty("response_format");
		expect(String(request.body.instructions)).toContain("optimizedPrompt");
		expect(String(request.body.instructions).startsWith("sys")).toBe(true);

		expect(result.reasoningSummary).toBe("补充了字段与校验。");
		expect(result.structured).toEqual({
			optimizedPrompt: "写一个登录页面。",
			reasoningSummary: "补充了字段与校验。",
		});
	});

	test("a supported upstream keeps text.format", async () => {
		const { request } = await drive(responsesProvider(), responsesSse([WITH_SUMMARY]), (provider) =>
			provider.generateWithMeta("draft", "openai:gpt-5", "sys", { responseFormat: FORMAT }),
		);
		expect(request.body.text).toEqual({
			format: {
				type: "json_schema",
				name: "prompt_optimize_result",
				schema: FORMAT.schema,
				strict: true,
			},
		});
		expect(request.body.instructions).toBe("sys");
	});

	test("a chat-only failure does not downgrade the Responses endpoint", async () => {
		// The same relay, but only the chat endpoint has been observed dropping
		// the constraint. `text.format` is a different field on a different
		// endpoint, so this request must still carry the native constraint.
		rememberMissingNativeStructuredOutput(CHAT_KEY);
		const { request } = await drive(responsesProvider(), responsesSse([WITH_SUMMARY]), (provider) =>
			provider.generateWithMeta("draft", RELAY_MODEL, "sys", { responseFormat: FORMAT }),
		);
		expect(request.body).toHaveProperty("text");
		expect(request.body.instructions).toBe("sys");
	});
});

describe("learning happens from a real failure", () => {
	test("a prose reply teaches the provider to stop sending the native constraint", async () => {
		// First call: native constraint requested, relay answers in prose.
		const first = await drive(chatProvider(), chatSse("Here is your prompt."), (provider) =>
			provider.generateWithMeta("draft", RELAY_MODEL, "sys", { responseFormat: FORMAT }),
		);
		expect(first.request.body).toHaveProperty("response_format");
		expect(first.result.responseFormatDegraded).toContain("OpenAI");
		expect(modelLacksNativeStructuredOutput(CHAT_KEY)).toBe(true);

		// Second call: the same relay is asked in text instead.
		const second = await drive(chatProvider(), chatSse(WITH_SUMMARY), (provider) =>
			provider.generateWithMeta("draft", RELAY_MODEL, "sys", { responseFormat: FORMAT }),
		);
		expect(second.request.body).not.toHaveProperty("response_format");
		expect(second.result.reasoningSummary).toBe("补充了字段与校验。");
	});

	test("a successful native call teaches nothing", async () => {
		await drive(chatProvider(), chatSse(WITH_SUMMARY), (provider) =>
			provider.generateWithMeta("draft", RELAY_MODEL, "sys", { responseFormat: FORMAT }),
		);
		expect(modelLacksNativeStructuredOutput(CHAT_KEY)).toBe(false);
	});
});
