/**
 * The task source for a narrator.
 *
 * Continuation, the task digest, the behavior fence, the interrupt guard and compact get
 * their tasks from here instead of reading `spec://tasks.json` themselves. Only the spec
 * implementation exists so far, so that is what every narrator gets.
 *
 * Extension point: once narrators carry a task backend, `resolveTaskBackend` reads it
 * (a subagent follows its root narrator) and the outline implementation is registered in
 * `TASK_SOURCE_FACTORIES`. The factory never rejects: an unreadable backend falls back to
 * spec, so readers need no fallback for the factory itself.
 */

import { createSpecTaskSource } from "./spec";
import type { NarratorTaskSource, TaskBackend } from "./types";

export type {
	ContinuationCause,
	ContinuationPromptInput,
	ContinuationTarget,
	ContinuationTask,
	InterruptGuardNote,
	NarratorTaskSource,
	OpenTaskList,
	OpenTaskStatus,
	OpenTaskView,
	TaskBackend,
	TaskStatus,
	TaskView,
} from "./types";

const TASK_SOURCE_FACTORIES: Record<TaskBackend, (narratorId: string) => NarratorTaskSource> = {
	spec: createSpecTaskSource,
};

/** The narrator's task backend. Narrators have no such field yet: always `spec`, no DB read. */
export async function resolveTaskBackend(_narratorId: string): Promise<TaskBackend> {
	return "spec";
}

/** The task source bound to this narrator. */
export async function taskSourceForNarrator(narratorId: string): Promise<NarratorTaskSource> {
	const backend = await resolveTaskBackend(narratorId);
	return TASK_SOURCE_FACTORIES[backend](narratorId);
}
