import { describe, expect, it } from "vitest";
import type { ProjectInfo } from "../../src/opencode/api-types.js";
import {
  baseName,
  normalizePathKey,
  projectName,
  resolveProject,
  summarizeProject,
} from "../../src/opencode/project-resolver.js";

const alpha: ProjectInfo = { id: "prj_alpha", canonical: "C:\\Users\\me\\code\\Alpha", name: "" };
const beta: ProjectInfo = {
  id: "prj_beta",
  canonical: "C:\\Users\\me\\code\\beta-repo",
  name: "Beta Tool",
  sandboxes: ["C:\\Users\\me\\sandboxes\\beta-1"],
};
const alphaCopy: ProjectInfo = { id: "prj_alpha2", canonical: "D:\\work\\alpha" };
const alphaUi: ProjectInfo = {
  id: "prj_alpha_ui",
  canonical: "C:\\Users\\me\\code\\Alpha\\packages\\ui",
};
const projects = [alpha, beta, alphaCopy, alphaUi];

describe("path helpers", () => {
  it("normalizes slashes, trailing slashes and case", () => {
    expect(normalizePathKey("C:\\Users\\Me\\Code\\")).toBe("c:/users/me/code");
    expect(normalizePathKey("/home/me//code/")).toBe("/home/me/code");
    expect(normalizePathKey("C:\\")).toBe("c:/");
    expect(normalizePathKey("/")).toBe("/");
  });

  it("derives base names and falls back to the folder name for an empty project name", () => {
    expect(baseName("C:\\Users\\me\\code\\Alpha\\")).toBe("Alpha");
    expect(baseName("/")).toBe("");
    expect(projectName(alpha)).toBe("Alpha");
    expect(projectName(beta)).toBe("Beta Tool");
    expect(projectName({ id: "prj_root", canonical: "/" })).toBe("prj_root");
    expect(summarizeProject(alpha)).toEqual({
      id: "prj_alpha",
      name: "Alpha",
      path: "C:\\Users\\me\\code\\Alpha",
    });
  });
});

describe("resolveProject", () => {
  it("resolves an exact id", () => {
    expect(resolveProject(projects, "prj_beta")).toMatchObject({
      status: "ok",
      by: "id",
      project: beta,
    });
  });

  it("resolves a path whatever the slashes, case or trailing slash", () => {
    for (const ref of [
      "C:\\Users\\me\\code\\beta-repo",
      "c:/users/ME/code/beta-repo/",
      "C:/Users/me/code/beta-repo",
    ]) {
      expect(resolveProject(projects, ref)).toMatchObject({
        status: "ok",
        by: "path",
        project: beta,
      });
    }
    expect(resolveProject(projects, "C:\\Users\\me\\sandboxes\\beta-1")).toMatchObject({
      status: "ok",
      project: beta,
    });
  });

  it("resolves a folder inside a project to the deepest enclosing project", () => {
    expect(resolveProject(projects, "C:\\Users\\me\\code\\Alpha\\src\\deep")).toMatchObject({
      status: "ok",
      by: "path",
      project: alpha,
    });
    expect(resolveProject(projects, "C:\\Users\\me\\code\\Alpha\\packages\\ui\\src")).toMatchObject(
      {
        status: "ok",
        project: alphaUi,
      },
    );
  });

  it("does not treat a sibling with the same prefix as inside a project", () => {
    expect(resolveProject(projects, "C:\\Users\\me\\code\\Alpha-other")).toEqual({
      status: "not_found",
    });
  });

  it("resolves names case-insensitively, by project name or folder base name", () => {
    expect(resolveProject(projects, "beta tool")).toMatchObject({
      status: "ok",
      by: "name",
      project: beta,
    });
    expect(resolveProject(projects, "BETA-REPO")).toMatchObject({ status: "ok", project: beta });
    expect(resolveProject(projects, "ui")).toMatchObject({ status: "ok", project: alphaUi });
  });

  it("returns every candidate for an ambiguous name instead of guessing", () => {
    const result = resolveProject(projects, "ALPHA");
    expect(result.status).toBe("ambiguous");
    if (result.status === "ambiguous") {
      expect(result.candidates.map((candidate) => candidate.id).sort()).toEqual([
        "prj_alpha",
        "prj_alpha2",
      ]);
    }
  });

  it("reports unknown and empty references as not found", () => {
    expect(resolveProject(projects, "nothing")).toEqual({ status: "not_found" });
    expect(resolveProject(projects, "E:\\elsewhere")).toEqual({ status: "not_found" });
    expect(resolveProject(projects, "   ")).toEqual({ status: "not_found" });
    expect(resolveProject([], "alpha")).toEqual({ status: "not_found" });
  });
});
