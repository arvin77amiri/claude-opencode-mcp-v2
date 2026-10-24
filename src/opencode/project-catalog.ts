import type { ProjectInfo, SessionListPage, SessionListQuery } from "./api-types.js";
import { normalizePathKey, projectName } from "./project-resolver.js";
import { isRootSession } from "./session-search.js";

/** The read-only slice of OpenCodeClient that project listing needs. */
export interface ProjectCatalogClient {
  projects(options?: { signal?: AbortSignal }): Promise<ProjectInfo[]>;
  sessionCount(project: string, options?: { signal?: AbortSignal }): Promise<number>;
  listSessions(
    query: SessionListQuery,
    options?: { signal?: AbortSignal },
  ): Promise<SessionListPage>;
}

export interface ProjectRow {
  id: string;
  /** Twin projects (the same folder under several ids) merged into this row; `id` comes first. */
  ids?: string[];
  name: string;
  path: string;
  /** Root sessions (sub-agent runs excluded); null when it could not be read in time. */
  session_count: number | null;
  /** ISO time of the newest session, falling back to the project's own timestamps. */
  last_activity: string | null;
}

export interface ProjectListing {
  /** Projects with at least one session, newest activity first (capped). */
  projects: ProjectRow[];
  /** Projects without any session, left out of `projects`. */
  hidden_empty: number;
  /** Projects with sessions that did not fit in `projects`. */
  omitted: number;
  /** The time budget ran out: some counts or activity times are missing. */
  partial: boolean;
}

export const MAX_PROJECT_ROWS = 40;
/** One page of sessions answers both "how many" and "when": counts are exact below this. */
export const COUNT_PAGE_SIZE = 100;

function iso(ms: number | undefined): string | null {
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0
    ? new Date(ms).toISOString()
    : null;
}

async function settle<T>(task: Promise<T>): Promise<T | null> {
  try {
    return await task;
  } catch {
    return null;
  }
}

async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

/**
 * Count and newest activity of one project from a single page of its newest sessions.
 * A full page means "at least that many": then the count falls back to the stats endpoint,
 * which counts root sessions too but is not exact (live: it missed sessions without work).
 */
export async function projectRow(
  client: ProjectCatalogClient,
  project: ProjectInfo,
  signal?: AbortSignal,
): Promise<ProjectRow> {
  const options = signal ? { signal } : {};
  const page = await settle(
    client.listSessions({ project: project.id, limit: COUNT_PAGE_SIZE, order: "desc" }, options),
  );
  let count: number | null = null;
  if (page) {
    count =
      page.data.length < COUNT_PAGE_SIZE
        ? page.data.filter(isRootSession).length
        : await settle(client.sessionCount(project.id, options));
  }
  return {
    id: project.id,
    name: projectName(project),
    path: project.canonical,
    session_count: count,
    last_activity:
      iso(page?.data[0]?.time?.updated) ?? iso(project.time?.updated) ?? iso(project.time?.active),
  };
}

/**
 * Rows of projects that share one canonical folder become ONE row: counts add up, the newest
 * activity wins, `id` is the most recently active twin and `ids` lists all of them. Rows with
 * different paths are left alone; the order of first appearance is kept.
 */
export function mergeTwinRows(rows: readonly ProjectRow[]): ProjectRow[] {
  const groups = new Map<string, ProjectRow[]>();
  for (const [index, row] of rows.entries()) {
    const key = normalizePathKey(row.path);
    // An empty path never merges: the rows cannot be told to be the same folder.
    const slot = key === "" ? `#${index}` : key;
    groups.set(slot, [...(groups.get(slot) ?? []), row]);
  }
  return [...groups.values()].map((group) => {
    const [first] = group;
    if (!first || group.length === 1) return first as ProjectRow;
    const primary = group.reduce((best, row) =>
      (row.last_activity ?? "") > (best.last_activity ?? "") ? row : best,
    );
    const counts = group.map((row) => row.session_count);
    const total = counts.every((count): count is number => count !== null)
      ? counts.reduce((sum, count) => sum + count, 0)
      : null;
    const newest = group.reduce<string | null>(
      (best, row) => ((row.last_activity ?? "") > (best ?? "") ? row.last_activity : best),
      null,
    );
    return {
      id: primary.id,
      ids: [primary.id, ...group.filter((row) => row !== primary).map((row) => row.id)],
      name: primary.name,
      path: primary.path,
      session_count: total,
      last_activity: newest,
    };
  });
}

/** Rows for the given projects (GET only); stops starting work once `signal` aborts. */
export async function describeProjects(
  client: ProjectCatalogClient,
  projects: readonly ProjectInfo[],
  options: { budgetMs?: number; concurrency?: number; signal?: AbortSignal } = {},
): Promise<{ rows: ProjectRow[]; partial: boolean }> {
  const own = options.signal ? null : new AbortController();
  const timer = own ? setTimeout(() => own.abort(), options.budgetMs ?? 15_000) : undefined;
  const signal = options.signal ?? own?.signal;
  try {
    const rows = await mapPool(projects, options.concurrency ?? 6, (project) =>
      projectRow(client, project, signal),
    );
    return { rows, partial: signal?.aborted ?? false };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** All projects that have sessions, with their count and last activity. */
export async function listProjectRows(
  client: ProjectCatalogClient,
  options: { budgetMs?: number; concurrency?: number } = {},
): Promise<ProjectListing> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.budgetMs ?? 15_000);
  try {
    const all = await client.projects({ signal: controller.signal });
    const { rows, partial } = await describeProjects(client, all, {
      ...(options.concurrency ? { concurrency: options.concurrency } : {}),
      signal: controller.signal,
    });
    const merged = mergeTwinRows(rows);
    const used = merged.filter((row) => row.session_count !== 0);
    used.sort((a, b) => (b.last_activity ?? "").localeCompare(a.last_activity ?? ""));
    return {
      projects: used.slice(0, MAX_PROJECT_ROWS),
      hidden_empty: merged.length - used.length,
      omitted: Math.max(0, used.length - MAX_PROJECT_ROWS),
      partial,
    };
  } finally {
    clearTimeout(timer);
  }
}
