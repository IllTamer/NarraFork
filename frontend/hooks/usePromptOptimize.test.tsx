import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

mock.module("./useInstanceSettings", () => ({
	useInstanceSettings: () => ({ promptOptimizeContextMaxMessages: 10 }),
}));
mock.module("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const { usePromptOptimize } = await import("./usePromptOptimize");
const { narratorsApi } = await import("../lib/api/narrators");
const { notifications } = await import("@mantine/notifications");
let root: Root;
let result: ReturnType<typeof usePromptOptimize>;
let applied: string[];
let requests: {
	signal: AbortSignal;
	resolve: (value: { text: string; reasoningSummary?: string }) => void;
	reject: (error: Error) => void;
}[];
const originals = new Map<string, PropertyDescriptor | undefined>();
let restore: (() => void)[];
function Probe() {
	result = usePromptOptimize({
		narratorId: "n",
		textareaRef: {
			current: {
				value: "original",
				ownerDocument: document,
				focus() {},
				setSelectionRange() {},
			} as unknown as HTMLTextAreaElement,
		},
		onOptimized: (text) => applied.push(text),
	});
	return null;
}
beforeEach(async () => {
	const { window } = parseHTML("<html><body></body></html>");
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	Object.assign(document, { execCommand: () => false });
	applied = [];
	requests = [];
	const api = spyOn(narratorsApi, "optimizePrompt").mockImplementation(
		(_id, _text, _style, options) =>
			new Promise((resolve, reject) =>
				requests.push({
					signal: options?.signal as AbortSignal,
					resolve: (value) => resolve({ ...value, model: "test" }),
					reject,
				}),
			),
	);
	const notify = spyOn(notifications, "show").mockImplementation(() => "id");
	restore = [() => api.mockRestore(), () => notify.mockRestore()];
	root = createRoot(document.body.appendChild(document.createElement("div")));
	await act(async () => root.render(<Probe />));
});
afterEach(async () => {
	await act(async () => root.unmount());
	for (const fn of restore) fn();
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	originals.clear();
});
test("cancel immediately clears loading and ignores a late successful response", async () => {
	let pending!: Promise<void>;
	await act(async () => {
		pending = result.handleOptimize("clarify");
	});
	expect(result.loading).toBe(true);
	await act(async () => result.cancelOptimize());
	expect(requests[0].signal.aborted).toBe(true);
	expect(result.loading).toBe(false);
	await act(async () => {
		requests[0].resolve({ text: "late" });
		await pending;
	});
	expect(applied).toEqual([]);
	expect(notifications.show).not.toHaveBeenCalled();
});
test("old request rejection cannot clear a newer request's loading", async () => {
	let first!: Promise<void>;
	let second!: Promise<void>;
	await act(async () => {
		first = result.handleOptimize("clarify");
	});
	await act(async () => {
		second = result.handleOptimize("concise");
	});
	await act(async () => {
		requests[0].reject(new Error("late failure"));
		await first;
	});
	expect(result.loading).toBe(true);
	expect(notifications.show).not.toHaveBeenCalled();
	await act(async () => {
		requests[1].resolve({ text: "new" });
		await second;
	});
	expect(applied).toEqual(["new"]);
	expect(result.loading).toBe(false);
});
test("unmount aborts and suppresses late text and notifications", async () => {
	let pending!: Promise<void>;
	await act(async () => {
		pending = result.handleOptimize("clarify");
	});
	await act(async () => root.unmount());
	expect(requests[0].signal.aborted).toBe(true);
	requests[0].resolve({ text: "late" });
	await pending;
	expect(applied).toEqual([]);
	expect(notifications.show).not.toHaveBeenCalled();
});

/**
 * What actually lands in the composer.
 *
 * The hook writes the server's `text` verbatim, so the server is responsible for
 * the payload being clean. These tests pin that the hook imposes no rewriting of
 * its own and does not append anything to the returned text — a regression here
 * would show up as thinking or framing leaking into the input box.
 */
test("writes the returned text verbatim and notifies success", async () => {
	let pending!: Promise<void>;
	await act(async () => {
		pending = result.handleOptimize("clarify");
	});
	await act(async () => {
		requests[0].resolve({ text: "写一个登录页面。" });
		await pending;
	});
	expect(applied).toEqual(["写一个登录页面。"]);
	expect(notifications.show).toHaveBeenCalledWith(
		expect.objectContaining({ message: "optimizeSuccess", color: "green" }),
	);
	expect(result.loading).toBe(false);
});

test("preserves multi-segment markers in the returned text", async () => {
	const optimized =
		"<<<NF_seg_0>>>\n写一个登录页面\n<<<NF_seg_0_END>>>\n<<<NF_seg_1>>>\n补充校验\n<<<NF_seg_1_END>>>";
	let pending!: Promise<void>;
	await act(async () => {
		pending = result.handleOptimize("structured");
	});
	await act(async () => {
		requests[0].resolve({ text: optimized });
		await pending;
	});
	// Markers are the client's rebuild keys: the hook must not trim or reflow them.
	expect(applied).toEqual([optimized]);
});

test("surfaces a server-side failure instead of writing anything", async () => {
	let pending!: Promise<void>;
	await act(async () => {
		pending = result.handleOptimize("clarify");
	});
	await act(async () => {
		requests[0].reject(new Error("context too long: no context available"));
		await pending;
	});
	expect(applied).toEqual([]);
	expect(notifications.show).toHaveBeenCalledWith(
		expect.objectContaining({ message: "optimizeNoContext", color: "red" }),
	);
	expect(result.loading).toBe(false);
});

/**
 * The rationale popup.
 *
 * The summary is presentation only — it must never be written into the composer,
 * and an absent or blank one must not raise a popup at all.
 */
function summaryCalls() {
	return (notifications.show as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(
		(call) => (call[0] as { title?: string }).title === "optimizeSummaryTitle",
	);
}

test("shows the rationale once when the server returns a summary", async () => {
	let pending!: Promise<void>;
	await act(async () => {
		pending = result.handleOptimize("clarify");
	});
	await act(async () => {
		requests[0].resolve({
			text: "写一个登录页面。",
			reasoningSummary: "补充了字段与校验要求。",
		});
		await pending;
	});
	const calls = summaryCalls();
	expect(calls).toHaveLength(1);
	expect(calls[0][0]).toEqual(
		expect.objectContaining({
			title: "optimizeSummaryTitle",
			message: "补充了字段与校验要求。",
			// Manually dismissable, and it goes away on its own.
			withCloseButton: true,
			autoClose: expect.any(Number),
		}),
	);
	// The summary is shown beside the result, never written into the prompt.
	expect(applied).toEqual(["写一个登录页面。"]);
});

test("does not show a popup when the summary is missing", async () => {
	let pending!: Promise<void>;
	await act(async () => {
		pending = result.handleOptimize("clarify");
	});
	await act(async () => {
		requests[0].resolve({ text: "写一个登录页面。" });
		await pending;
	});
	expect(summaryCalls()).toHaveLength(0);
	// The success notification still fires.
	expect(notifications.show).toHaveBeenCalledWith(
		expect.objectContaining({ message: "optimizeSuccess" }),
	);
});

test("does not show a popup when the summary is blank", async () => {
	let pending!: Promise<void>;
	await act(async () => {
		pending = result.handleOptimize("clarify");
	});
	await act(async () => {
		requests[0].resolve({ text: "写一个登录页面。", reasoningSummary: "   " });
		await pending;
	});
	expect(summaryCalls()).toHaveLength(0);
});

test("does not repeat the popup for the same summary within one optimization", async () => {
	// The same result must not stack two popups: a rerender or a duplicate
	// notification path would otherwise show it twice.
	let pending!: Promise<void>;
	await act(async () => {
		pending = result.handleOptimize("clarify");
	});
	await act(async () => {
		requests[0].resolve({ text: "写一个登录页面。", reasoningSummary: "补充校验。" });
		await pending;
	});
	expect(summaryCalls()).toHaveLength(1);
});

test("a cancelled optimization never shows the rationale", async () => {
	let pending!: Promise<void>;
	await act(async () => {
		pending = result.handleOptimize("clarify");
	});
	await act(async () => result.cancelOptimize());
	await act(async () => {
		requests[0].resolve({ text: "late", reasoningSummary: "should not appear" });
		await pending;
	});
	expect(summaryCalls()).toHaveLength(0);
	expect(applied).toEqual([]);
});
