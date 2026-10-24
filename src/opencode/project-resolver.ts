import type { ProjectInfo } from "./api-types.js";

/** Forward slashes, no trailing slash, lower case: paths compare case-insensitively (Windows). */
export function normalizePathKey(value: string): string {
  const slashed = value
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/");
  const trimmed =
    slashed.length > 1 && !/^[a-zA-Z]:\/$/.test(slashed) ? slashed.replace(/\/+$/, "") : slashed;
  return trimmed.toLowerCase();
}

export function baseName(value: string): string {
  const parts = value.trim().replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

/** `name` is often empty in OpenCode: fall back to the folder name, then the id. */
export function projectName(project: ProjectInfo): string {
  return project.name?.trim() || baseName(project.canonical) || project.id;
}

export interface ProjectSummary {
  id: string;
  name: string;
  path: string;
}

export function summarizeProject(project: ProjectInfo): ProjectSummary {
  return { id: project.id, name: projectName(project), path: project.canonical };
}

export type ProjectResolution =
  | { status: "ok"; project: ProjectInfo; by: "id" | "path" | "name" }
  | { status: "ambiguous"; candidates: ProjectInfo[] }
  | { status: "not_found" };

function looksLikePath(ref: string): boolean {
  return /[\\/]/.test(ref) || /^[a-zA-Z]:/.test(ref);
}

function roots(project: ProjectInfo): string[] {
  return [project.canonical, ...(project.sandboxes ?? [])].map(normalizePathKey);
}

function unique(projects: ProjectInfo[]): ProjectInfo[] {
  const seen = new Set<string>();
  return projects.filter((project) => !seen.has(project.id) && seen.add(project.id));
}

function pick(matches: ProjectInfo[], by: "id" | "path" | "name"): ProjectResolution | null {
  const list = unique(matches);
  if (list.length === 0) return null;
  const [only] = list;
  if (list.length === 1 && only) return { status: "ok", project: only, by };
  return { status: "ambiguous", candidates: list };
}

/**
 * Resolve a project reference: an id, a folder path (also a sub-folder of a project, or one of
 * its sandboxes) or a name (case-insensitive; the project name or the folder's base name).
 * Several candidates are returned as `ambiguous`; the bridge never guesses between them.
 */
export function resolveProject(
  projects: readonly ProjectInfo[],
  reference: string,
): ProjectResolution {
  const ref = reference.trim();
  if (!ref) return { status: "not_found" };

  const byId = projects.filter((project) => project.id === ref);
  const idHit = pick(byId, "id");
  if (idHit) return idHit;

  if (looksLikePath(ref)) {
    const key = normalizePathKey(ref);
    const exact = pick(
      projects.filter((project) => roots(project).includes(key)),
      "path",
    );
    if (exact) return exact;

    // A folder inside a project: the deepest enclosing project wins.
    let best: ProjectInfo[] = [];
    let bestLength = -1;
    for (const project of projects) {
      for (const root of roots(project)) {
        if (root.length > 1 && key.startsWith(`${root}/`)) {
          if (root.length > bestLength) {
            best = [project];
            bestLength = root.length;
          } else if (root.length === bestLength) {
            best.push(project);
          }
        }
      }
    }
    return pick(best, "path") ?? { status: "not_found" };
  }

  const lower = ref.toLowerCase();
  return (
    pick(
      projects.filter(
        (project) =>
          projectName(project).toLowerCase() === lower ||
          baseName(project.canonical).toLowerCase() === lower,
      ),
      "name",
    ) ?? { status: "not_found" }
  );
}
