import { describe, expect, it } from "vitest";
import type { ProjectInfo, SessionInfo, SessionListQuery } from "../../src/opencode/api-types.js";
import {
  COUNT_PAGE_SIZE,
  listProjectRows,
  MAX_PROJECT_ROWS,
  type ProjectCatalogClient,
  projectRow,
} from "../../src/opencode/project-catalog.js";

function sessionsOf(count: number, extra: (index: number) => Partial<SessionInfo> = () => ({})) {
  return Array.from(
    { length: count },
    (_, index): SessionInfo => ({
      id: `ses_${index}`,
      title: `s${index}`,
      time: { created: 1, updated: 1_000_000 - index },
      ...extra(index),
    }),
  );
}

class StubClient implements ProjectCatalogClient {
  readonly listCalls: SessionListQuery[] = [];
  statsCalls = 0;

  constructor(
    private readonly projectList: ProjectInfo[],
    private readonly sessionsByProject: Record<string, SessionInfo[]>,
    private readonly options: { statsCount?: number; failList?: string[] } = {},
  ) {}

  async projects(): Promise<ProjectInfo[]> {
    return this.projectList;
  }

  async sessionCount(): Promise<number> {
    this.statsCalls += 1;
    return this.options.statsCount ?? -1;
  }

  async listSessions(query: SessionListQuery) {
    this.listCalls.push({ ...query });
    if (this.options.failList?.includes(query.project ?? "")) throw new Error("boom");
    return { data: (this.sessionsByProject[query.project ?? ""] ?? []).slice(0, query.limit) };
  }
}

const project = (id: string, canonical = `C:\\work\\${id}`): ProjectInfo => ({ id, canonical });

describe("projectRow", () => {
  it("counts root sessions from one page and takes the newest time from it", async () => {
    const client = new StubClient([], {
      prj: sessionsOf(5, (index) => (index === 0 ? { parentID: "ses_1" } : {})),
    });
    const row = await projectRow(client, project("prj"));
    expect(row).toEqual({
      id: "prj",
      name: "prj",
      path: "C:\\work\\prj",
      session_count: 4,
      last_activity: new Date(1_000_000).toISOString(),
    });
    expect(client.listCalls).toEqual([{ project: "prj", limit: COUNT_PAGE_SIZE, order: "desc" }]);
    expect(client.statsCalls).toBe(0);
  });

  it("falls back to the stats count when the page is full", async () => {
    const client = new StubClient(
      [],
      { prj: sessionsOf(COUNT_PAGE_SIZE + 20) },
      { statsCount: 130 },
    );
    const row = await projectRow(client, project("prj"));
    expect(row.session_count).toBe(130);
    expect(client.statsCalls).toBe(1);
  });

  it("reports an unreadable count as null and uses the project's own time", async () => {
    const client = new StubClient([], {}, { failList: ["prj"] });
    const row = await projectRow(client, {
      ...project("prj"),
      time: { created: 1, updated: 5_000 },
    });
    expect(row.session_count).toBeNull();
    expect(row.last_activity).toBe(new Date(5_000).toISOString());
  });
});

describe("listProjectRows", () => {
  it("hides empty projects, sorts by activity and flags unreadable counts", async () => {
    const client = new StubClient(
      [project("old"), project("empty"), project("new"), project("broken")],
      {
        old: sessionsOf(2).map((entry) => ({ ...entry, time: { created: 1, updated: 100 } })),
        new: sessionsOf(1),
      },
      { failList: ["broken"] },
    );
    const listing = await listProjectRows(client);
    expect(listing.projects.map((row) => [row.id, row.session_count])).toEqual([
      ["new", 1],
      ["old", 2],
      ["broken", null],
    ]);
    expect(listing.hidden_empty).toBe(1);
    expect(listing.omitted).toBe(0);
    expect(listing.partial).toBe(false);
  });

  it("caps the number of rows and reports how many were left out", async () => {
    const many = Array.from({ length: MAX_PROJECT_ROWS + 5 }, (_, index) => project(`p${index}`));
    const sessions = Object.fromEntries(many.map((entry) => [entry.id, sessionsOf(1)]));
    const listing = await listProjectRows(new StubClient(many, sessions));
    expect(listing.projects).toHaveLength(MAX_PROJECT_ROWS);
    expect(listing.omitted).toBe(5);
  });
});
