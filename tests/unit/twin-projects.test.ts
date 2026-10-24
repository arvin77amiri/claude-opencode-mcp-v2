import { describe, expect, it } from "vitest";
import type { ProjectInfo, SessionInfo, SessionListQuery } from "../../src/opencode/api-types.js";
import {
  listProjectRows,
  mergeTwinRows,
  type ProjectCatalogClient,
  type ProjectRow,
} from "../../src/opencode/project-catalog.js";
import { resolveProjectGroup, shareCanonicalPath } from "../../src/opencode/project-resolver.js";
import { mergeSearchResults, type SearchResult } from "../../src/opencode/session-search.js";

const twinA: ProjectInfo = { id: "prj_a", canonical: "C:\\Users\\me\\Research\\Paper" };
const twinB: ProjectInfo = { id: "prj_b", canonical: "c:/users/me/research/paper/", name: "Paper" };
const other: ProjectInfo = { id: "prj_o", canonical: "D:\\elsewhere\\paper" };
const lone: ProjectInfo = { id: "prj_l", canonical: "C:\\work\\lone" };

describe("resolveProjectGroup", () => {
  it("merges ambiguous candidates that share one canonical path", () => {
    const result = resolveProjectGroup([twinA, twinB, lone], "paper");
    expect(result).toEqual({ status: "ok", projects: [twinA, twinB] });
  });

  it("keeps the project the caller named first and pulls its twin in", () => {
    const byId = resolveProjectGroup([twinA, twinB, lone], "prj_b");
    expect(byId).toEqual({ status: "ok", projects: [twinB, twinA] });
    const byPath = resolveProjectGroup([twinA, twinB, lone], "C:\\Users\\me\\Research\\Paper");
    expect(byPath).toMatchObject({ status: "ok" });
    expect(byPath.status === "ok" && byPath.projects.map((project) => project.id)).toEqual([
      "prj_a",
      "prj_b",
    ]);
  });

  it("stays ambiguous when the candidates have different paths", () => {
    const result = resolveProjectGroup([twinA, other, lone], "paper");
    expect(result.status).toBe("ambiguous");
    expect(result.status === "ambiguous" && result.candidates.map((p) => p.id)).toEqual([
      "prj_a",
      "prj_o",
    ]);
  });

  it("stays ambiguous when twins are mixed with a different folder", () => {
    const result = resolveProjectGroup([twinA, twinB, other], "paper");
    expect(result.status).toBe("ambiguous");
  });

  it("returns a single project as a group of one and passes not_found through", () => {
    expect(resolveProjectGroup([twinA, lone], "prj_l")).toEqual({ status: "ok", projects: [lone] });
    expect(resolveProjectGroup([twinA, lone], "nothing")).toEqual({ status: "not_found" });
  });

  it("never merges projects without a path", () => {
    expect(
      shareCanonicalPath([
        { id: "x", canonical: "" },
        { id: "y", canonical: "" },
      ]),
    ).toBe(false);
    expect(shareCanonicalPath([])).toBe(false);
  });
});

describe("mergeTwinRows", () => {
  const row = (
    id: string,
    path: string,
    count: number | null,
    last: string | null,
  ): ProjectRow => ({
    id,
    name: id,
    path,
    session_count: count,
    last_activity: last,
  });

  it("adds counts, keeps the newest activity and the most recent twin as id", () => {
    const merged = mergeTwinRows([
      row("prj_a", "C:\\Paper", 3, "2026-10-01T00:00:00.000Z"),
      row("prj_x", "C:\\other", 1, "2026-10-02T00:00:00.000Z"),
      row("prj_b", "c:/paper/", 4, "2026-10-05T00:00:00.000Z"),
    ]);
    expect(merged).toEqual([
      {
        id: "prj_b",
        ids: ["prj_b", "prj_a"],
        name: "prj_b",
        path: "c:/paper/",
        session_count: 7,
        last_activity: "2026-10-05T00:00:00.000Z",
      },
      row("prj_x", "C:\\other", 1, "2026-10-02T00:00:00.000Z"),
    ]);
  });

  it("leaves rows with different paths alone and reports an unknown count as null", () => {
    const rows = [row("a", "C:\\one", 1, null), row("b", "C:\\two", 2, null)];
    expect(mergeTwinRows(rows)).toEqual(rows);
    const [merged] = mergeTwinRows([row("a", "C:\\p", null, null), row("b", "C:\\p", 2, null)]);
    expect(merged?.session_count).toBeNull();
  });
});

class StubClient implements ProjectCatalogClient {
  constructor(
    private readonly projectList: ProjectInfo[],
    private readonly sessions: Record<string, SessionInfo[]>,
  ) {}
  async projects(): Promise<ProjectInfo[]> {
    return this.projectList;
  }
  async sessionCount(): Promise<number> {
    return 0;
  }
  async listSessions(query: SessionListQuery) {
    return { data: this.sessions[query.project ?? ""] ?? [] };
  }
}

describe("listProjectRows with twins", () => {
  it("lists twin projects as one row and hides a twin pair with no sessions", async () => {
    const ses = (id: string, updated: number): SessionInfo => ({
      id,
      time: { created: 1, updated },
    });
    const client = new StubClient(
      [
        twinA,
        twinB,
        lone,
        { id: "prj_e1", canonical: "C:\\empty" },
        { id: "prj_e2", canonical: "C:\\EMPTY" },
      ],
      { prj_a: [ses("s1", 2_000), ses("s2", 1_000)], prj_b: [ses("s3", 3_000)] },
    );
    const listing = await listProjectRows(client);
    expect(listing.projects).toHaveLength(1);
    expect(listing.projects[0]).toMatchObject({
      id: "prj_b",
      ids: ["prj_b", "prj_a"],
      session_count: 3,
      last_activity: new Date(3_000).toISOString(),
    });
    // The lone project and the empty twin pair have no sessions; they count as 2 hidden rows.
    expect(listing.hidden_empty).toBe(2);
  });
});

describe("mergeSearchResults", () => {
  const hit = (id: string, updated: string, match?: "title" | "content") => ({
    session_id: id,
    title: id,
    updated,
    ...(match ? { match } : {}),
  });
  const result = (
    sessions: SearchResult["sessions"],
    extra: Partial<SearchResult> = {},
  ): SearchResult => ({
    sessions,
    scanned: 2,
    partial: false,
    ...extra,
  });

  it("sorts title matches first, then content, then recents, each newest first", () => {
    const merged = mergeSearchResults(
      [
        result([hit("a_content", "2026-10-03T00:00:00.000Z", "content")]),
        result([
          hit("b_title", "2026-10-01T00:00:00.000Z", "title"),
          hit("b_content", "2026-10-04T00:00:00.000Z", "content"),
        ]),
      ],
      10,
    );
    expect(merged.sessions.map((s) => s.session_id)).toEqual(["b_title", "b_content", "a_content"]);
    expect(merged.scanned).toBe(4);
  });

  it("merges recents by recency, applies the limit and drops duplicates", () => {
    const merged = mergeSearchResults(
      [
        result([hit("s1", "2026-10-01T00:00:00.000Z"), hit("s3", "2026-10-03T00:00:00.000Z")]),
        result([hit("s2", "2026-10-02T00:00:00.000Z"), hit("s3", "2026-10-03T00:00:00.000Z")]),
      ],
      2,
    );
    expect(merged.sessions.map((s) => s.session_id)).toEqual(["s3", "s2"]);
  });

  it("combines partial flags and scan errors", () => {
    const merged = mergeSearchResults(
      [
        result([], { scan_errors: 1, scan_error: "boom" }),
        result([], { partial: true, scan_errors: 2 }),
      ],
      5,
    );
    expect(merged).toMatchObject({ partial: true, scan_errors: 3, scan_error: "boom" });
  });
});
