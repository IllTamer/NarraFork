/**
 * The outline agent tools across spaces, on the isolated SQLite database: reading and searching
 * other spaces the session may read (addresses, labels, the read ledger), the overview of every
 * readable space (`OutlineRead` with address `*`), links to what the session may not read, and
 * `OutlineEdit` in other spaces, which follows the person's write permission as it always has.
 * The permission matrix of who reads what, on SQLite and PostgreSQL, is in `access-matrix.ts`
 * (groups `listing` and `agent`).
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; every case makes its own users,
 * projects and sessions.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../../db";
import { aclGrants, narrators, outlineBlocks, projects, users } from "../../../db/schema";
import {
	outlineEditTool,
	outlineReadTool,
	outlineSearchTool,
} from "../../../lib/agent/tools/outline";
import type { ToolContext, ToolDefinition, ToolResult } from "../../../lib/agent/types";
import { generateId } from "../../../lib/id";
import { settings } from "../../../lib/settings";
import { OUTLINE_AGENT_READ_LIMITS } from "../agent-read";
import { OUTLINE_TOOL_TEXT } from "../messages";
import { clearOutlineReads, seenOutlineVersion } from "../read-ledger";
import { invalidateSessionReadScopes } from "../session-scope";
import { ensurePersonalSpace, ensureProjectSpace, ensureSessionSpace } from "../spaces";
import type { OutlineSpaceRow } from "../store/port";
import { type OutlineOp, writeOutline } from "../write";

const NOW = "2026-10-26T00:00:00.000Z";

async function user(label: string): Promise<string> {
	const id = generateId();
	await db
		.insert(users)
		.values({ id, username: `${label}-${id}`, passwordHash: "x", role: "user", createdAt: NOW });
	return id;
}

async function project(owner: string, name: string, visibility = "private"): Promise<string> {
	const id = generateId();
	await db.insert(projects).values({
		id,
		name,
		ownerUserId: owner,
		visibility: visibility as "private",
		createdAt: NOW,
		updatedAt: NOW,
	});
	return id;
}

async function narrator(
	owner: string,
	projectId: string | null,
	extra: Partial<typeof narrators.$inferInsert> = {},
): Promise<string> {
	const id = generateId();
	await db.insert(narrators).values({
		id,
		title: "cross-space",
		ownerUserId: owner,
		visibility: "private",
		contextProjectId: projectId,
		createdAt: NOW,
		updatedAt: NOW,
		...extra,
	});
	return id;
}

function ctx(narratorId: string, userId: string | null): ToolContext {
	return {
		narratorId,
		cwd: "/",
		signal: new AbortController().signal,
		locale: "en",
		userId,
		requestPermission: async () => ({ behavior: "allow" }),
	} as ToolContext;
}

async function call(
	tool: ToolDefinition,
	args: Record<string, unknown>,
	context: ToolContext,
): Promise<ToolResult> {
	return await tool.execute(args, context);
}

/** The labels a result lists after bullets, in order. */
function labels(output: string): string[] {
	return [...output.matchAll(/^\s*- \[([A-Za-z0-9/]+)\]/gm)].map((m) => m[1] as string);
}

/** Write blocks as a person; the sids of what was inserted, in order. */
async function write(space: OutlineSpaceRow, userId: string, ops: OutlineOp[]): Promise<string[]> {
	const r = await writeOutline({
		spaceId: space.id,
		ops,
		actor: { kind: "human", id: userId },
		responsibleUserId: userId,
	});
	return r.results.map((x) => x.sid);
}

async function blockBySid(space: OutlineSpaceRow, sid: string) {
	const rows = await db.select().from(outlineBlocks).where(eq(outlineBlocks.spaceId, space.id));
	const row = rows.find((r) => r.sid === sid);
	if (!row) throw new Error(`no block ${sid}`);
	return row;
}

/**
 * Alice works in a session of Atlas. She can also read Billing (a project of hers), her other
 * session's notes, and Hidden is Bob's (not hers to read).
 */
async function world() {
	const alice = await user("alice");
	const bob = await user("bob");
	const atlasId = await project(alice, "Atlas");
	const billingId = await project(alice, "Billing");
	const session = await narrator(alice, atlasId);
	const otherSession = await narrator(alice, atlasId, { title: "Login bug" });
	const atlas = await ensureProjectSpace(atlasId);
	const billing = await ensureProjectSpace(billingId);
	const hidden = await ensureProjectSpace(await project(bob, "Hidden"));
	const notes = await ensureSessionSpace(session);
	const otherNotes = await ensureSessionSpace(otherSession);
	return { alice, bob, session, otherSession, atlas, billing, hidden, notes, otherNotes };
}

beforeEach(() => {
	settings.outline.enabled = true;
	invalidateSessionReadScopes();
	clearOutlineReads();
});

afterEach(() => {
	invalidateSessionReadScopes();
});

describe("reading another space", () => {
	test("by key/id: labeled key/id, recorded as read", async () => {
		const w = await world();
		const [page, child] = await write(w.billing, w.alice, [
			{ op: "insert", tempId: "p", parent: null, content: "Invoices" },
			{ op: "insert", parent: { tempId: "p" }, content: "Totals are kept in cents" },
		]);
		const c = ctx(w.session, w.alice);
		const read = await call(outlineReadTool, { address: `${w.billing.key}/${page}` }, c);
		expect(read.isError).toBeUndefined();
		const lines = read.output.split("\n");
		expect(lines[0]).toBe(`‹space ${w.billing.key} · project "Billing"›`);
		expect(labels(read.output)).toEqual([`${w.billing.key}/${page}`, `${w.billing.key}/${child}`]);
		const row = await blockBySid(w.billing, child as string);
		expect(seenOutlineVersion(w.session, row.id)).toBe(row.versionSeq);

		// Bare ids are looked up in the session's own spaces only: the label is the address.
		const bare = await call(outlineReadTool, { address: child as string }, c);
		expect(bare.isError).toBe(true);
		const byLabel = await call(outlineReadTool, { address: `${w.billing.key}/${child}` }, c);
		expect(byLabel.output).toContain("Totals are kept in cents");

		// A space's pages, listed by key.
		const list = await call(outlineReadTool, { address: `${w.billing.key}/` }, c);
		expect(list.output).toContain(`- [${w.billing.key}/${page}] Invoices`);
	});

	test("the session's own spaces keep short ids", async () => {
		const w = await world();
		const [own] = await write(w.atlas, w.alice, [{ op: "insert", parent: null, content: "Ours" }]);
		const [note] = await write(w.notes, w.alice, [{ op: "insert", parent: null, content: "Mine" }]);
		const c = ctx(w.session, w.alice);
		const read = await call(outlineReadTool, { address: own as string }, c);
		expect(labels(read.output)).toEqual([own]);
		const notes = await call(outlineReadTool, { address: `session/${note}` }, c);
		expect(labels(notes.output)).toEqual([note]);
	});

	test("another session's notes, when every reader of this one may read them", async () => {
		const w = await world();
		const [sid] = await write(w.otherNotes, w.alice, [
			{ op: "insert", parent: null, content: "Repro steps" },
		]);
		const read = await call(
			outlineReadTool,
			{ address: `${w.otherNotes.key}/${sid}` },
			ctx(w.session, w.alice),
		);
		expect(read.output.split("\n")[0]).toBe(`‹space ${w.otherNotes.key} · session "Login bug"›`);
		expect(read.output).toContain(`- [${w.otherNotes.key}/${sid}] Repro steps`);
		// Shared with Bob, the session may read only what Bob may read too.
		await db.insert(aclGrants).values({
			id: generateId(),
			scopeType: "narrator",
			scopeId: w.session,
			principalType: "user",
			principalId: w.bob,
			capability: "read",
			createdAt: NOW,
		});
		await db.insert(aclGrants).values({
			id: generateId(),
			scopeType: "project",
			scopeId: w.atlas.projectId as string,
			principalType: "user",
			principalId: w.bob,
			capability: "read",
			createdAt: NOW,
		});
		invalidateSessionReadScopes();
		const narrowed = await call(
			outlineReadTool,
			{ address: `${w.otherNotes.key}/${sid}` },
			ctx(w.session, w.alice),
		);
		expect(narrowed.output).toBe(OUTLINE_TOOL_TEXT.notFound(`${w.otherNotes.key}/${sid}`));
	});

	test("what the session may not read answers exactly as what does not exist", async () => {
		const w = await world();
		const [secret] = await write(w.hidden, w.bob, [
			{ op: "insert", parent: null, content: "Secret zebra" },
		]);
		const c = ctx(w.session, w.alice);
		const pairs: Array<[string, string]> = [
			[`${w.hidden.key}/${secret}`, `${w.billing.key}/Zz9Zz9Zz`],
			[`${w.hidden.key}/${secret}`, `Nokey123/${secret}`],
			[`${w.hidden.key}/`, "Nokey123/"],
		];
		const swap = (text: string, from: string, to: string) => text.split(from).join(to);
		for (const [hidden, missing] of pairs) {
			const a = await call(outlineReadTool, { address: hidden }, c);
			const b = await call(outlineReadTool, { address: missing }, c);
			expect(a.isError).toBe(true);
			expect(b.isError).toBe(true);
			expect(swap(a.output, hidden.replace(/\/$/, ""), "X")).toBe(
				swap(b.output, missing.replace(/\/$/, ""), "X"),
			);
		}
		const searchHidden = await call(
			outlineSearchTool,
			{ query: "zebra", spaces: [w.hidden.key] },
			c,
		);
		const searchMissing = await call(
			outlineSearchTool,
			{ query: "zebra", spaces: ["Nokey123"] },
			c,
		);
		expect(swap(searchHidden.output, w.hidden.key, "X")).toBe(
			swap(searchMissing.output, "Nokey123", "X"),
		);
		const all = await call(outlineSearchTool, { query: "zebra", spaces: ["*"] }, c);
		expect(all.output).not.toContain(w.hidden.key);
		expect(all.output).not.toContain("Secret");
	});
});

describe("links to what the session may not read", () => {
	test("show no title, like a link to nothing, and are never expanded", async () => {
		const w = await world();
		const [secret] = await write(w.hidden, w.bob, [
			{ op: "insert", parent: null, content: "Secret zebra" },
		]);
		const [invoices] = await write(w.billing, w.alice, [
			{ op: "insert", parent: null, content: "Invoices" },
		]);
		const hiddenRef = `${w.hidden.key}/${secret}`;
		const missingRef = `${w.billing.key}/Zz9Zz9Zz`;
		const readableRef = `${w.billing.key}/${invoices}`;
		const [page] = await write(w.atlas, w.alice, [
			{
				op: "insert",
				parent: null,
				content: `see [[${hiddenRef}]], [[${missingRef}]] and [[${readableRef}]]`,
			},
			{ op: "insert", parent: null, content: `![[${hiddenRef}]]` },
			{ op: "insert", parent: null, content: `![[${missingRef}]]` },
		]);
		const c = ctx(w.session, w.alice);
		const read = await call(outlineReadTool, { address: page as string }, c);
		expect(read.output).toContain(
			`see [[${hiddenRef}]], [[${missingRef}]] and [[${readableRef}|Invoices]]`,
		);
		expect(read.output).not.toContain("Secret");
		const overview = await call(outlineReadTool, { address: "*" }, c);
		expect(overview.output).toContain(`![[${hiddenRef}]]`);
		expect(overview.output).toContain(`![[${missingRef}]]`);
		expect(overview.output).not.toContain("Secret");
	});
});

describe("the overview of every readable space", () => {
	test("its own spaces first, then the others, each with its pages within the budget", async () => {
		const w = await world();
		await write(w.atlas, w.alice, [
			{ op: "insert", tempId: "a", parent: null, content: "Auth module" },
			{ op: "insert", parent: { tempId: "a" }, content: "Tokens live on the server" },
			{
				op: "insert",
				parent: { tempId: "a" },
				content: "Add a regression test",
				task: { status: "todo" },
			},
		]);
		const [invoices] = await write(w.billing, w.alice, [
			{ op: "insert", tempId: "i", parent: null, content: "Invoices" },
			{ op: "insert", parent: { tempId: "i" }, content: "Totals are kept in cents" },
		]);
		await write(w.hidden, w.bob, [{ op: "insert", parent: null, content: "Secret zebra" }]);
		const personal = await ensurePersonalSpace(w.alice);
		await write(personal, w.alice, [{ op: "insert", parent: null, content: "My preferences" }]);
		const c = ctx(w.session, w.alice);
		const result = await call(outlineReadTool, { address: "*" }, c);
		expect(result.isError).toBeUndefined();
		const out = result.output;
		const keys = (result.metadata?.spaces as Array<{ key: string; own: boolean }>).map(
			(s) => s.key,
		);
		// Own spaces first (project, session, personal), then the others.
		expect(keys.slice(0, 3)).toEqual([w.atlas.key, w.notes.key, personal.key]);
		expect(keys).toContain(w.billing.key);
		expect(keys).toContain(w.otherNotes.key);
		expect(keys).not.toContain(w.hidden.key);
		expect(out).not.toContain("Secret");
		expect(out.split("\n")[0]).toContain("this session can read, its own first");
		expect(out).toContain(`‹space ${w.atlas.key} · this session's project "Atlas"; bare ids`);
		expect(out).toContain("- [");
		expect(out).toContain("Tokens live on the server");
		expect(out).not.toContain("regression");
		expect(out).toContain("‹facts only: 1 block under tasks not shown");
		expect(out).toContain(`‹space ${w.billing.key} · project "Billing"›`);
		expect(out).toContain(`- [${w.billing.key}/${invoices}] Invoices`);
		expect(out).toContain("Totals are kept in cents");
		expect(out).toContain(`‹space ${w.notes.key} · this session's notes›\n‹no pages yet›`);
		expect(out).toContain("My preferences");
		expect(result.metadata?.complete).toBe(true);
		// What it showed is a read.
		const row = await blockBySid(w.billing, invoices as string);
		expect(seenOutlineVersion(w.session, row.id)).toBe(row.versionSeq);

		// A small budget fills the top level of every space first.
		const small = await call(outlineReadTool, { address: "*", budget: 3 }, c);
		expect(small.output).toContain("Auth module");
		expect(small.output).toContain("Invoices");
		expect(small.output).not.toContain("Tokens live");
		expect(small.output).not.toContain("Totals are kept");
		expect(small.output).toMatch(/^ {2}‹… 1 more›$/m);

		const all = await call(outlineReadTool, { address: "*", view: "all" }, c);
		expect(all.output).toContain("[ ] Add a regression test");

		const asOf = await call(outlineReadTool, { address: "*", asOf: 1 }, c);
		expect(asOf.isError).toBe(true);
		expect(asOf.output).toBe(OUTLINE_TOOL_TEXT.overviewNotAsOf);
	});

	test("another session's notes are process: the facts view counts their pages", async () => {
		const w = await world();
		const [repro] = await write(w.otherNotes, w.alice, [
			{ op: "insert", tempId: "r", parent: null, content: "Repro steps" },
			{ op: "insert", parent: { tempId: "r" }, content: "Log in twice" },
			{ op: "insert", parent: null, content: "Hypotheses" },
		]);
		await write(w.notes, w.alice, [{ op: "insert", parent: null, content: "Our own notes" }]);
		const c = ctx(w.session, w.alice);
		const facts = await call(outlineReadTool, { address: "*" }, c);
		expect(facts.output).toContain(
			`‹space ${w.otherNotes.key} · session "Login bug"›\n‹${OUTLINE_TOOL_TEXT.otherSessionPages(2, false)}›`,
		);
		expect(facts.output).not.toContain("Repro steps");
		expect(facts.output).not.toContain("Hypotheses");
		// The session's own notes are listed as before.
		expect(facts.output).toContain("Our own notes");
		const meta = facts.metadata?.spaces as Array<{ key: string; process?: boolean }>;
		expect(meta.find((s) => s.key === w.otherNotes.key)?.process).toBe(true);
		expect(meta.find((s) => s.key === w.notes.key)?.process).toBeUndefined();

		const all = await call(outlineReadTool, { address: "*", view: "all" }, c);
		expect(all.output).toContain(`- [${w.otherNotes.key}/${repro}] Repro steps`);
		expect(all.output).toContain("Log in twice");
		expect(all.output).toContain("Hypotheses");
		// Read by address as ever.
		const byKey = await call(outlineReadTool, { address: `${w.otherNotes.key}/` }, c);
		expect(byKey.output).toContain(`- [${w.otherNotes.key}/${repro}] Repro steps`);
	});

	test("pages that are tasks, pages too large to expand, and spaces past the budget", async () => {
		const w = await world();
		await write(w.atlas, w.alice, [
			{ op: "insert", parent: null, content: "A task page", task: { status: "todo" } },
		]);
		const big = Array.from({ length: OUTLINE_AGENT_READ_LIMITS.overviewPageBlocks }, (_, i) => ({
			op: "insert" as const,
			parent: { tempId: "big" },
			content: `line ${i}`,
		}));
		const [bigPage] = await write(w.billing, w.alice, [
			{ op: "insert", tempId: "big", parent: null, content: "Big page" },
			...big.slice(0, 199),
		]);
		await write(
			w.billing,
			w.alice,
			big.slice(199, 398).map((op) => ({
				...op,
				parent: { sid: bigPage as string },
			})) as OutlineOp[],
		);
		await write(
			w.billing,
			w.alice,
			big.slice(398).map((op) => ({
				...op,
				parent: { sid: bigPage as string },
			})) as OutlineOp[],
		);
		const c = ctx(w.session, w.alice);
		const result = await call(outlineReadTool, { address: "*" }, c);
		expect(result.output).toContain(OUTLINE_TOOL_TEXT.taskPagesHidden(1));
		expect(result.output).toContain(`- [${w.billing.key}/${bigPage}] Big page`);
		expect(result.output).toContain(
			OUTLINE_TOOL_TEXT.notExpanded([`[${w.billing.key}/${bigPage}]`]),
		);
		expect(result.output).not.toContain("line 0");
		expect(result.metadata?.truncated).toBe(true);
	});

	test("a session that can read nothing yet", async () => {
		const owner = await user("solo");
		const session = await narrator(owner, null);
		const result = await call(outlineReadTool, { address: "*" }, ctx(session, null));
		expect(result.output).toBe(OUTLINE_TOOL_TEXT.allSpacesNone);
	});
});

describe("searching every readable space", () => {
	test('spaces ["*"] covers other spaces; the default stays with the own spaces', async () => {
		const w = await world();
		await write(w.billing, w.alice, [
			{ op: "insert", parent: null, content: "Kraken ledger rounding" },
		]);
		await write(w.otherNotes, w.alice, [{ op: "insert", parent: null, content: "Kraken repro" }]);
		await write(w.hidden, w.bob, [{ op: "insert", parent: null, content: "Kraken secret" }]);
		const c = ctx(w.session, w.alice);
		const own = await call(outlineSearchTool, { query: "Kraken" }, c);
		expect(own.output).toContain(OUTLINE_TOOL_TEXT.noResultsOwn);
		const all = await call(outlineSearchTool, { query: "Kraken", spaces: ["*"] }, c);
		const hits = labels(all.output);
		expect(hits).toHaveLength(2);
		expect(hits.some((h) => h.startsWith(`${w.billing.key}/`))).toBe(true);
		expect(hits.some((h) => h.startsWith(`${w.otherNotes.key}/`))).toBe(true);
		expect(all.output).not.toContain("secret");
		// Another session's notes are process, ranked after facts.
		expect(hits[0]).toStartWith(`${w.billing.key}/`);
		expect(all.output).toContain("in a session's notes");
		// A result reads by the address it gives.
		const read = await call(outlineReadTool, { address: hits[0] as string }, c);
		expect(read.output).toContain("Kraken ledger rounding");
	});
});

describe("OutlineEdit and other spaces", () => {
	test("another project's space the person may write is written, as before", async () => {
		const w = await world();
		const [invoices] = await write(w.billing, w.alice, [
			{ op: "insert", parent: null, content: "Invoices" },
		]);
		const key = w.billing.key;
		const c = ctx(w.session, w.alice);
		const added = await call(
			outlineEditTool,
			{ edits: [{ add: `${key}/`, markdown: "- Refunds" }] },
			c,
		);
		expect(added.isError).toBeUndefined();
		expect(added.output).toContain(`to ${key} · project "Billing"`);
		// Someone else wrote it: read it, then edit it by its address, as a read labels it too.
		await call(outlineReadTool, { address: `${key}/${invoices}` }, c);
		const replaced = await call(
			outlineEditTool,
			{ edits: [{ replace: `[${key}/${invoices}]`, text: "Invoices v2" }] },
			c,
		);
		expect(replaced.isError).toBeUndefined();
		const set = await call(
			outlineEditTool,
			{ edits: [{ set: `${key}/${invoices}`, checkbox: "x" }] },
			c,
		);
		expect(set.isError).toBeUndefined();
		const child = await call(
			outlineEditTool,
			{ edits: [{ add: `${key}/${invoices}`, markdown: "- paid in full" }] },
			c,
		);
		expect(child.isError).toBeUndefined();
		const row = await blockBySid(w.billing, invoices as string);
		expect(row.content).toBe("Invoices v2");
		expect(row.taskJson?.status).toBe("done");
		const rows = await db
			.select()
			.from(outlineBlocks)
			.where(eq(outlineBlocks.spaceId, w.billing.id));
		const refunds = rows.find((r) => r.content === "Refunds");
		expect(refunds?.parentId).toBeNull();
		expect(rows.find((r) => r.content === "paid in full")?.parentId).toBe(row.id);
		const deleted = await call(
			outlineEditTool,
			{ edits: [{ delete: `${key}/${refunds?.sid}` }] },
			c,
		);
		expect(deleted.isError).toBeUndefined();
		expect((await blockBySid(w.billing, refunds?.sid as string)).deleted).toBe(true);
	});

	test("a readable space the person may not write is refused, as before", async () => {
		const w = await world();
		const open = await ensureProjectSpace(await project(w.bob, "Open", "public"));
		const [theirs] = await write(open, w.bob, [{ op: "insert", parent: null, content: "Theirs" }]);
		const c = ctx(w.session, w.alice);
		const read = await call(outlineReadTool, { address: `${open.key}/${theirs}` }, c);
		expect(read.output).toContain("Theirs");
		for (const edit of [
			{ add: `${open.key}/`, markdown: "- mine" },
			{ replace: `${open.key}/${theirs}`, text: "changed" },
		]) {
			const refused = await call(outlineEditTool, { edits: [edit] }, c);
			expect(refused.isError).toBe(true);
			expect(refused.output).toContain("Nothing was written.");
			expect(refused.output).toContain(
				OUTLINE_TOOL_TEXT.edit.noPermission(`${open.key} · project "Open"`),
			);
		}
		expect((await blockBySid(open, theirs as string)).content).toBe("Theirs");
		// A space it may not read is not found, as ever.
		const hidden = await call(
			outlineEditTool,
			{ edits: [{ add: `${w.hidden.key}/`, markdown: "- nope" }] },
			c,
		);
		expect(hidden.output).toContain(OUTLINE_TOOL_TEXT.noSuchSpace(`${w.hidden.key}/`));
	});

	test("what a read of another space shows, copied into the session's own, loses its labels", async () => {
		const w = await world();
		const [invoices] = await write(w.billing, w.alice, [
			{ op: "insert", parent: null, content: "Invoices" },
		]);
		const c = ctx(w.session, w.alice);
		const copied = await call(outlineReadTool, { address: `${w.billing.key}/${invoices}` }, c);
		const markdown = `${copied.output.split("\n").slice(1).join("\n")}\n- see [[${w.billing.key}/${invoices}]]`;
		const added = await call(outlineEditTool, { edits: [{ add: "/", markdown }] }, c);
		expect(added.isError).toBeUndefined();
		const pages = await db
			.select()
			.from(outlineBlocks)
			.where(eq(outlineBlocks.spaceId, w.atlas.id));
		expect(pages.map((p) => p.content).sort()).toEqual([
			"Invoices",
			`see [[${w.billing.key}/${invoices}]]`,
		]);
	});

	test("a subagent reads across spaces as its root does", async () => {
		const w = await world();
		const [invoices] = await write(w.billing, w.alice, [
			{ op: "insert", parent: null, content: "Invoices" },
		]);
		const sub = await narrator(w.alice, null, { type: "subagent", aclRootNarratorId: w.session });
		const c = ctx(sub, w.alice);
		const read = await call(outlineReadTool, { address: `${w.billing.key}/${invoices}` }, c);
		expect(read.output).toContain(`- [${w.billing.key}/${invoices}] Invoices`);
		const overview = await call(outlineReadTool, { address: "*" }, c);
		const keys = (overview.metadata?.spaces as Array<{ key: string }>).map((s) => s.key);
		expect(keys.slice(0, 2)).toEqual([w.atlas.key, w.notes.key]);
		expect(keys).toContain(w.otherNotes.key);
		const own = await call(
			outlineEditTool,
			{ edits: [{ add: "session/", markdown: "- from the subagent" }] },
			c,
		);
		expect(own.isError).toBeUndefined();
	});
});
