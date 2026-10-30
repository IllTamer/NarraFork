/**
 * What an agent working in a session may read from the outline.
 *
 * Whatever an agent reads can end up in the session (its context, the transcript, what it writes
 * next), and everyone who can read the session sees that. So a session may read only what EVERY
 * person who can read the session may read. Admins can read everything and never narrow that
 * set. A subagent is judged on its root narrator, like every other access decision about it.
 *
 *   - Its own session space (its root's, for a subagent): always.
 *   - A public session (visibility `public`, or an active public share link): only the spaces of
 *     projects every signed-in user can read. Its main project's space only if that project is
 *     one of them; other sessions' spaces never.
 *   - Any other session: its readers are the owner; when visibility is `project` (or the `user`
 *     role holds a grant on it), everyone past its main project's gate; and the users granted
 *     the session who pass that gate. A space is readable when every one of them can read it.
 *     The main project's space qualifies whenever the owner can read it, since everyone else
 *     came in through that project.
 *   - A personal space: only its owner's, only in a single-user session (visibility `private`,
 *     no share link, nobody but the owner and admins can read it), and only in a turn the owner
 *     runs. A turn with no person behind it (a routine, a system turn) reads nothing personal.
 *   - A session without a main project reads only its own session space and that personal space.
 *   - Orphaned spaces: nothing.
 *
 * Readers are enumerated, never guessed, up to {@link OUTLINE_SESSION_READER_CAP} people who are
 * not admins. Past the cap only what is open to every signed-in user, and the main project's
 * space, stay readable. A list of every reader of a session exists nowhere else in the
 * repository (`listNarratorAudience` deliberately under-reports), so this answers space by space
 * rather than producing a readable set; {@link listSessionReadableSpaces} lists one by judging
 * candidates that SQL narrows down first, a bounded number of them.
 *
 * CACHING
 * -------
 * The readers of a session, and each verdict about a space, are kept per narrator for
 * {@link SESSION_SCOPE_TTL_MS} and dropped at once when access changes: `narrator:access_changed`
 * (audiences, grants, owner, share links), `project:access_changed` (visibility, members, owner)
 * and `auth:changed` (roles, deleted users) clear everything, since one change can move verdicts
 * of many sessions. The time limit covers what is not announced: a session moving to another
 * main project, or a project being deleted. Work per check is bounded: computing a session's
 * readers is a dozen indexed, limited reads; a verdict is a few more.
 */
import { eventBus } from "@server/lib/event-bus";
import { hotOnce, hotSafe } from "@server/lib/hot-safe";
import { resolveNarratorProjectId } from "../narrator-project";
import {
	GRANT_CAPABILITIES,
	holdsAnyCapability,
	narratorUsersWith,
	projectOpenToEveryone,
	projectUsersWith,
} from "./access";
import {
	type NarratorAccessRow,
	type OutlineSpaceCandidates,
	type ProjectAccessRow,
	readHasActivePublicShare,
	readJudgedNarrator,
	readNarrator,
	readNonAdminGrantees,
	readNonAdminUserIds,
	readProject,
	readScopeGrants,
	readSpaceCandidatePage,
} from "./access-reads";
import { isOrphanedSpace } from "./spaces";
import { outlineStore } from "./store";
import type { OutlineSpaceRow } from "./store/port";

/**
 * The most people (not counting admins) a session's readers are enumerated for. A session read
 * by more can still read its own space, its main project's space and spaces every signed-in user
 * can read.
 */
export const OUTLINE_SESSION_READER_CAP = 50;

/** How long a session's readers and verdicts are reused when no access change is announced. */
export const SESSION_SCOPE_TTL_MS = 30_000;

const MAX_CACHED_SESSIONS = 256;
const MAX_VERDICTS_PER_SESSION = 512;

export type SessionAudience =
	/** Every signed-in user, or people outside the instance through a public link. */
	| { kind: "everyone" }
	/** Exactly these people, admins left out (they do not narrow anything). */
	| { kind: "people"; userIds: readonly string[] }
	/** More than {@link OUTLINE_SESSION_READER_CAP} people. */
	| { kind: "too_many" };

export interface SessionReadScope {
	narratorId: string;
	/**
	 * The narrator whose readers count: the session itself, or its root for a subagent. Null when
	 * the narrator does not exist or its root cannot be determined; nothing is readable then.
	 */
	rootNarratorId: string | null;
	ownerUserId: string | null;
	/** The session's main project, null when it has none or it no longer exists. */
	mainProjectId: string | null;
	audience: SessionAudience;
	/** Private, not shared by link, and read by nobody but its owner and admins. */
	singleUser: boolean;
}

interface ScopeState extends SessionReadScope {
	/** The owner unless an admin: the one reader not admitted through the main project. */
	ownerReader: string | null;
	mainProject: ProjectAccessRow | null;
}

interface CacheEntry {
	state: Promise<ScopeState>;
	/** Known once `state` settles; lets an invalidation for a root reach its subagents. */
	rootNarratorId?: string | null;
	expiresAt: number;
	verdicts: Map<string, Promise<boolean>>;
}

const cache = hotSafe("narrafork.outline.sessionReadScopes", () => ({
	entries: new Map<string, CacheEntry>(),
}));

const EVERYONE: SessionAudience = { kind: "everyone" };
const TOO_MANY: SessionAudience = { kind: "too_many" };

function people(userIds: Iterable<string>): SessionAudience {
	const list = [...new Set(userIds)];
	return list.length > OUTLINE_SESSION_READER_CAP ? TOO_MANY : { kind: "people", userIds: list };
}

// ─────────────────────────────────────────────────────────────────────────────
// Who reads the session
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The people who are not admins and can read a session that is neither public nor shared by
 * link, as `canReadNarrator` admits them. `mainProjectId` set with `mainProject` null is a
 * project that no longer exists: its gate admits nobody, so only the owner remains.
 */
async function readersOf(
	root: NarratorAccessRow,
	mainProjectId: string | null,
	mainProject: ProjectAccessRow | null,
	ownerReader: string | null,
): Promise<SessionAudience> {
	const readers = new Set<string>(ownerReader ? [ownerReader] : []);
	if (mainProjectId !== null && mainProject === null) return people(readers);
	const limit = OUTLINE_SESSION_READER_CAP + 1;
	const narrator = { type: "narrator", id: root.id } as const;

	const roleGrants = await readScopeGrants(narrator, []);
	const throughGate =
		(root.visibility === "project" && mainProject !== null) ||
		holdsAnyCapability(roleGrants.everyUser, GRANT_CAPABILITIES.narrator.read);
	if (throughGate) {
		// Everyone past the project gate reads the session; with no project, everyone does.
		if (mainProject === null || (await projectOpenToEveryone(mainProject))) return EVERYONE;
		const members = await readNonAdminGrantees(
			{ type: "project", id: mainProject.id },
			GRANT_CAPABILITIES.project.read,
			limit,
		);
		if (members.length >= limit) return TOO_MANY;
		for (const member of members) readers.add(member);
		if (mainProject.ownerUserId !== null) {
			for (const owner of await readNonAdminUserIds([mainProject.ownerUserId])) readers.add(owner);
		}
	}

	const grantees = await readNonAdminGrantees(narrator, GRANT_CAPABILITIES.narrator.read, limit);
	if (grantees.length >= limit) return TOO_MANY;
	// A grant counts only past the project gate, as it does when the grantee opens the session.
	const admitted = mainProject
		? await projectUsersWith(mainProject, grantees, "read")
		: new Set(grantees);
	for (const grantee of grantees) if (admitted.has(grantee)) readers.add(grantee);
	return people(readers);
}

function unreadable(narratorId: string): ScopeState {
	return {
		narratorId,
		rootNarratorId: null,
		ownerUserId: null,
		mainProjectId: null,
		audience: TOO_MANY,
		singleUser: false,
		ownerReader: null,
		mainProject: null,
	};
}

async function computeScope(narratorId: string): Promise<ScopeState> {
	const row = await readNarrator(narratorId);
	const root = row ? await readJudgedNarrator(row) : null;
	if (!root) return unreadable(narratorId);
	const mainProjectId = await resolveNarratorProjectId(root);
	const mainProject = mainProjectId === null ? null : await readProject(mainProjectId);
	const ownerReader =
		root.ownerUserId !== null &&
		(await readNonAdminUserIds([root.ownerUserId])).has(root.ownerUserId)
			? root.ownerUserId
			: null;
	const shared = root.visibility === "public" || (await readHasActivePublicShare(root.id));
	const audience = shared
		? EVERYONE
		: await readersOf(root, mainProjectId, mainProject, ownerReader);
	const singleUser =
		root.ownerUserId !== null &&
		root.visibility === "private" &&
		!shared &&
		audience.kind === "people" &&
		audience.userIds.every((userId) => userId === root.ownerUserId);
	return {
		narratorId,
		rootNarratorId: root.id,
		ownerUserId: root.ownerUserId,
		mainProjectId: mainProject?.id ?? null,
		audience,
		singleUser,
		ownerReader,
		mainProject,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Verdicts
// ─────────────────────────────────────────────────────────────────────────────

async function projectVerdict(state: ScopeState, projectId: string): Promise<boolean> {
	if (state.mainProject === null) return false;
	const project = await readProject(projectId);
	if (!project) return false;
	if (state.audience.kind === "everyone") return await projectOpenToEveryone(project);
	if (project.id === state.mainProject.id) {
		// Everyone but the owner came in through this project's gate.
		const owner = state.ownerReader;
		return owner === null || (await projectUsersWith(project, [owner], "read")).has(owner);
	}
	if (state.audience.kind === "too_many") return await projectOpenToEveryone(project);
	const readers = state.audience.userIds;
	return (await projectUsersWith(project, readers, "read")).size === readers.length;
}

async function sessionVerdict(state: ScopeState, narratorId: string): Promise<boolean> {
	const target = await readNarrator(narratorId);
	const judged = target ? await readJudgedNarrator(target) : null;
	if (!target || !judged) return false;
	// Another subagent of the same session has the same readers.
	if (judged.id === state.rootNarratorId) return true;
	if (state.mainProject === null || state.audience.kind !== "people") return false;
	const readers = state.audience.userIds;
	return (await narratorUsersWith(target, readers, "read")).size === readers.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache
// ─────────────────────────────────────────────────────────────────────────────

function entryFor(narratorId: string): CacheEntry {
	const now = Date.now();
	const cached = cache.entries.get(narratorId);
	if (cached && cached.expiresAt > now) return cached;
	const entry: CacheEntry = {
		state: computeScope(narratorId),
		expiresAt: now + SESSION_SCOPE_TTL_MS,
		verdicts: new Map(),
	};
	entry.state.then(
		(state) => {
			entry.rootNarratorId = state.rootNarratorId;
		},
		() => {
			if (cache.entries.get(narratorId) === entry) cache.entries.delete(narratorId);
		},
	);
	cache.entries.delete(narratorId);
	cache.entries.set(narratorId, entry);
	while (cache.entries.size > MAX_CACHED_SESSIONS) {
		const oldest = cache.entries.keys().next().value;
		if (oldest === undefined) break;
		cache.entries.delete(oldest);
	}
	return entry;
}

async function memo(
	entry: CacheEntry,
	key: string,
	compute: () => Promise<boolean>,
): Promise<boolean> {
	const cached = entry.verdicts.get(key);
	if (cached) return await cached;
	if (entry.verdicts.size >= MAX_VERDICTS_PER_SESSION) entry.verdicts.clear();
	const verdict = compute();
	entry.verdicts.set(key, verdict);
	verdict.catch(() => {
		if (entry.verdicts.get(key) === verdict) entry.verdicts.delete(key);
	});
	return await verdict;
}

/**
 * Drop cached readers and verdicts: of one session (and the subagents judged on it) when
 * `narratorId` is given, of every session otherwise. Access changes announced on the event bus
 * already do this; call it after changing access some other way.
 */
export function invalidateSessionReadScopes(narratorId?: string): void {
	if (narratorId === undefined) {
		cache.entries.clear();
		return;
	}
	for (const [key, entry] of cache.entries) {
		const root = entry.rootNarratorId;
		// An entry still being computed may belong to a subagent of this session: drop it too.
		if (key === narratorId || root === narratorId || root === undefined) {
			cache.entries.delete(key);
		}
	}
}

if (hotOnce("narrafork.outline.sessionReadScopes.listeners")) {
	const clear = () => cache.entries.clear();
	eventBus.on("narrator:access_changed", clear);
	eventBus.on("project:access_changed", clear);
	eventBus.on("auth:changed", clear);
}

// ─────────────────────────────────────────────────────────────────────────────
// API
// ─────────────────────────────────────────────────────────────────────────────

/** Who reads the session, as the checks below see it. */
export async function getSessionReadScope(narratorId: string): Promise<SessionReadScope> {
	const state = await entryFor(narratorId).state;
	return {
		narratorId: state.narratorId,
		rootNarratorId: state.rootNarratorId,
		ownerUserId: state.ownerUserId,
		mainProjectId: state.mainProjectId,
		audience: state.audience,
		singleUser: state.singleUser,
	};
}

export interface SessionReadOptions {
	/** The person this turn runs for; absent for routines and system turns. */
	executingUserId?: string | null;
}

/**
 * Whether an agent working in the session may read the space: its pages, search hits and
 * anything injected from it.
 */
export async function canSessionReadSpace(
	narratorId: string,
	space: OutlineSpaceRow,
	options: SessionReadOptions = {},
): Promise<boolean> {
	const entry = entryFor(narratorId);
	const state = await entry.state;
	if (state.rootNarratorId === null || isOrphanedSpace(space)) return false;
	const { projectId, narratorId: spaceNarratorId } = space;
	if (space.kind === "session" && spaceNarratorId) {
		if (spaceNarratorId === state.rootNarratorId || spaceNarratorId === narratorId) return true;
		return await memo(entry, `session:${spaceNarratorId}`, () =>
			sessionVerdict(state, spaceNarratorId),
		);
	}
	if (space.kind === "project" && projectId) {
		return await memo(entry, `project:${projectId}`, () => projectVerdict(state, projectId));
	}
	if (space.kind === "personal") {
		const executing = options.executingUserId;
		return (
			Boolean(executing) &&
			state.singleUser &&
			executing === state.ownerUserId &&
			space.ownerUserId === executing
		);
	}
	return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Listing
// ─────────────────────────────────────────────────────────────────────────────

export const OUTLINE_SESSION_LIST_LIMITS = {
	/** Spaces one listing returns at most. */
	maxSpaces: 200,
	/**
	 * Candidates one listing judges, by default: a session read by several people is offered
	 * every space one of them reads, and only some pass.
	 */
	defaultCandidates: 300,
	/** Candidates one listing may be asked to judge at most. */
	maxCandidates: 2000,
	/** Candidate rows one statement reads. */
	candidatePage: 100,
} as const;

export interface SessionReadableSpaces {
	/** Readable spaces, the session's own first (see {@link listSessionReadableSpaces}). */
	spaces: OutlineSpaceRow[];
	/** False when more may be readable than were listed: a limit cut the listing short. */
	complete: boolean;
}

/** Where to look for what the session may read besides its own spaces; null: nowhere. */
function candidateSource(
	state: ScopeState,
): { from: OutlineSpaceCandidates; kinds: Array<"project" | "session"> } | null {
	// Without a main project nothing but the session's own space and personal space is readable.
	if (state.mainProject === null) return null;
	if (state.audience.kind !== "people") return { from: { kind: "open" }, kinds: ["project"] };
	// Any reader will do: the session reads only what all of them read. The owner comes first.
	const anchor = state.audience.userIds[0];
	return {
		from: anchor === undefined ? { kind: "all" } : { kind: "reader", userId: anchor },
		kinds: ["project", "session"],
	};
}

function clampCount(value: number | undefined, fallback: number, max: number): number {
	return value === undefined || !Number.isFinite(value)
		? fallback
		: Math.max(1, Math.min(max, Math.floor(value)));
}

/**
 * The spaces an agent working in the session may read, each judged by
 * {@link canSessionReadSpace}, so nothing is listed that a read by key would refuse. In order:
 * the session's own space (its root's), its main project's, the personal space (for the turn's
 * person), then other projects' spaces, then other sessions' spaces, each kind in id order.
 *
 * Candidates come from SQL, filtered before the LIMIT: the spaces one reader of the session reads
 * (the owner unless an admin) and what is open to every signed-in user; every space when only
 * admins read the session; spaces of projects open to everyone for a public session, one shared
 * by link or one past the reader cap (other sessions' spaces are never readable then).
 *
 * Bounded: at most `limit` spaces (200) and `maxCandidates` candidates judged (300 by default),
 * a hundred rows per statement; verdicts are cached with the session's scope. `complete` says
 * whether the listing reached the end.
 */
export async function listSessionReadableSpaces(
	narratorId: string,
	options: SessionReadOptions & { limit: number; maxCandidates?: number },
): Promise<SessionReadableSpaces> {
	const state = await entryFor(narratorId).state;
	const limit = clampCount(options.limit, 1, OUTLINE_SESSION_LIST_LIMITS.maxSpaces);
	const maxCandidates = clampCount(
		options.maxCandidates,
		OUTLINE_SESSION_LIST_LIMITS.defaultCandidates,
		OUTLINE_SESSION_LIST_LIMITS.maxCandidates,
	);
	const read = { executingUserId: options.executingUserId ?? null };
	const out: OutlineSpaceRow[] = [];
	const seen = new Set<string>();
	const consider = async (space: OutlineSpaceRow | null) => {
		if (!space || seen.has(space.id)) return;
		seen.add(space.id);
		if (await canSessionReadSpace(narratorId, space, read)) out.push(space);
	};
	const done = (complete: boolean): SessionReadableSpaces => ({
		spaces: out.slice(0, limit),
		complete: complete && out.length <= limit,
	});
	if (state.rootNarratorId === null) return done(true);

	await consider(
		await outlineStore.findSpace({ kind: "session", narratorId: state.rootNarratorId }),
	);
	if (state.mainProjectId !== null) {
		await consider(
			await outlineStore.findSpace({ kind: "project", projectId: state.mainProjectId }),
		);
	}
	if (read.executingUserId) {
		await consider(
			await outlineStore.findSpace({ kind: "personal", ownerUserId: read.executingUserId }),
		);
	}

	const source = candidateSource(state);
	if (source === null) return done(true);
	const page = OUTLINE_SESSION_LIST_LIMITS.candidatePage;
	let judged = 0;
	for (const kind of source.kinds) {
		let afterId: string | undefined;
		for (;;) {
			const rows = await readSpaceCandidatePage(source.from, { kind, afterId, limit: page });
			for (const space of rows) {
				if (seen.has(space.id)) continue;
				// One past the limit tells that the listing is not complete.
				if (out.length > limit || judged >= maxCandidates) return done(false);
				judged++;
				await consider(space);
			}
			const last = rows[rows.length - 1];
			if (rows.length < page || !last) break;
			afterId = last.id;
		}
	}
	return done(true);
}
