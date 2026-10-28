import { useInstanceSettings } from "@frontend/hooks/useInstanceSettings";
import { narratorsApi } from "@frontend/lib/api/narrators";
import { notifications } from "@mantine/notifications";
import type { RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export type OptimizeStyle = "clarify" | "concise" | "structured" | "translate_en";

const STORAGE_KEY = "narrafork_optimize_with_context";

export interface UsePromptOptimizeOptions {
	narratorId: string;
	messageId?: string; // For editing message context
	withContext?: boolean; // Shared context preference for an alternate editor
	textareaRef: RefObject<HTMLTextAreaElement | null>;
	/**
	 * Callback after successful optimization.
	 * NOT called when using document.execCommand (browser handles it).
	 */
	onOptimized?: (text: string) => void;
	/** Structured editors capture a versioned text-only transformation; atoms never enter the prompt. */
	target?: () => { text: string; apply: (text: string) => boolean } | null;
}

export interface UsePromptOptimizeResult {
	loading: boolean;
	withContext: boolean;
	contextMessageCount: number;
	toggleContext: () => void;
	setContextMessageCount: (count: number) => void;
	handleOptimize: (style: OptimizeStyle) => Promise<void>;
	cancelOptimize: () => void;
}

export function usePromptOptimize(options: UsePromptOptimizeOptions): UsePromptOptimizeResult {
	const { t } = useTranslation("narrator");
	const is = useInstanceSettings();
	const [contextMessageCount, setContextMessageCount] = useState(
		is.promptOptimizeContextMaxMessages,
	);

	// Sync with settings when it changes
	useEffect(() => {
		setContextMessageCount(is.promptOptimizeContextMaxMessages);
	}, [is.promptOptimizeContextMaxMessages]);

	const [loading, setLoading] = useState(false);
	const [withContext, setWithContext] = useState(() => {
		try {
			return localStorage.getItem(STORAGE_KEY) === "true";
		} catch {
			return false;
		}
	});
	const abortRef = useRef<AbortController | null>(null);
	/**
	 * Last rationale surfaced, so a repeated identical summary does not raise a
	 * second popup for what the user already read. Reset per optimization request.
	 */
	const shownSummaryRef = useRef<string | null>(null);
	const cancelOptimize = useCallback(() => {
		abortRef.current?.abort();
		abortRef.current = null;
		setLoading(false);
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: Changing the target invalidates its pending optimization.
	useEffect(() => {
		setLoading(false);
		return () => {
			abortRef.current?.abort();
			abortRef.current = null;
		};
	}, [options.narratorId, options.messageId]);

	const handleOptimize = useCallback(
		async (style: OptimizeStyle) => {
			const textarea = options.textareaRef.current;
			const target = options.target?.();
			const originalText = target?.text ?? textarea?.value ?? "";
			if (!originalText.trim()) return;

			// Save preference
			try {
				localStorage.setItem(STORAGE_KEY, String(options.withContext ?? withContext));
			} catch {
				// Ignore localStorage errors
			}

			// Abort previous request
			if (abortRef.current) {
				abortRef.current.abort();
			}
			const controller = new AbortController();
			abortRef.current = controller;
			// A new request may legitimately produce the same summary text again;
			// dedupe is per-request, not global.
			shownSummaryRef.current = null;
			setLoading(true);

			try {
				const result = await narratorsApi.optimizePrompt(options.narratorId, originalText, style, {
					withContext: options.withContext ?? withContext,
					messageId: options.messageId,
					signal: controller.signal,
				});

				if (controller.signal.aborted || abortRef.current !== controller) return;

				if (target) {
					if (!target.apply(result.text)) throw new Error(t("richComposer.optimizeChanged"));
				} else if (textarea) {
					// A late result must never overwrite intervening input.
					if (textarea.value !== originalText) throw new Error(t("richComposer.optimizeChanged"));
					textarea.focus();
					textarea.setSelectionRange(0, textarea.value.length);
					const success = textarea.ownerDocument.execCommand("insertText", false, result.text);
					if (!success && options.onOptimized) options.onOptimized(result.text);
				}

				notifications.show({
					message: t("optimizeSuccess"),
					color: "green",
					autoClose: 8000,
				});

				// Presentation only: the rationale is shown beside the result and never
				// enters the composer. Guarded so one optimization raises one popup even
				// if the same summary comes back twice.
				const summary = result.reasoningSummary?.trim();
				if (summary && shownSummaryRef.current !== summary) {
					shownSummaryRef.current = summary;
					notifications.show({
						title: t("optimizeSummaryTitle"),
						message: summary,
						color: "indigo",
						autoClose: 12000,
						withCloseButton: true,
					});
				}
			} catch (err) {
				if (
					controller.signal.aborted ||
					abortRef.current !== controller ||
					(err as Error).name === "AbortError"
				) {
					return; // User cancelled
				}

				// Better error messages
				let errorMessage = (err as Error).message || t("optimizeFailedGeneric");
				if (errorMessage.includes("timed out") || errorMessage.includes("timeout")) {
					errorMessage = t("optimizeTimeout");
				} else if (errorMessage.includes("context") && errorMessage.includes("available")) {
					errorMessage = t("optimizeNoContext");
				}

				notifications.show({
					title: t("optimizeFailed"),
					message: errorMessage,
					color: "red",
					autoClose: 10000,
				});
			} finally {
				if (abortRef.current === controller) {
					setLoading(false);
					abortRef.current = null;
				}
			}
		},
		[options, withContext, t],
	);

	const toggleContext = useCallback(() => {
		setWithContext((prev) => !prev);
	}, []);

	return {
		loading,
		withContext,
		contextMessageCount,
		toggleContext,
		setContextMessageCount,
		handleOptimize,
		cancelOptimize,
	};
}
