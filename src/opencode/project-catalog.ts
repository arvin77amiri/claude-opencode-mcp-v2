import type { ProjectInfo, SessionListPage, SessionListQuery } from "./api-types.js";
import { projectName } from "./project-resolver.js";
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
    const used = rows.filter((row) => row.session_count !== 0);
    used.sort((a, b) => (b.last_activity ?? "").localeCompare(a.last_activity ?? ""));
    return {
      projects: used.slice(0, MAX_PROJECT_ROWS),
      hidden_empty: rows.length - used.length,
      omitted: Math.max(0, used.length - MAX_PROJECT_ROWS),
      partial,
    };
  } finally {
    clearTimeout(timer);
  }
}
