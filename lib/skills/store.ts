// Reads skill definitions from .skills/ at call time, so skills the agent writes are picked up immediately.
import fsAsync from "fs/promises";
import path from "path";
import { createLogger } from "../infra/logger";
import type { SkillDefinition } from "./types";

const log = createLogger("skillStore");

/** Hidden workspace metadata directory holding the workspace's public A2A/MCP contracts. */
export const SKILLS_DIR = ".skills";

// The id doubles as the MCP tool name, so it must match MCP's charset everywhere. It is the skill's only
// name, so keep it short and readable.
export const SKILL_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Structural check only (ajv validates at call time); a malformed skill is skipped with a warning.
function parseSkill(raw: unknown, file: string): SkillDefinition | null {
  if (!isRecord(raw)) return null;
  const { id, description, input, output } = raw;
  if (typeof id !== "string" || !id) {
    log.warn({ file }, "skill file missing string 'id' — skipped");
    return null;
  }
  if (!SKILL_ID_RE.test(id)) {
    log.warn({ file, id }, "skill 'id' must match ^[a-zA-Z0-9_-]{1,64}$ and be concise and human-readable — skipped");
    return null;
  }
  if (!isRecord(input) || input.type !== "object" || !isRecord(output) || output.type !== "object") {
    log.warn({ file, id }, "skill input and output must be JSON Schemas with type 'object' — skipped");
    return null;
  }
  return {
    id,
    description: typeof description === "string" ? description : "",
    input,
    output,
  };
}

/** Reads and parses all .skills/*.json in a workspace dir. Missing dir → empty list. */
export async function loadSkills(workspaceDir: string): Promise<SkillDefinition[]> {
  const dir = path.join(workspaceDir, SKILLS_DIR);
  let entries: string[];
  try {
    entries = await fsAsync.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn({ err, dir }, "failed to read skills directory — treating workspace as having no skills");
    }
    return []; // no .skills/ directory — workspace declares no skills
  }

  const skills: SkillDefinition[] = [];
  for (const entry of entries.filter((e) => e.endsWith(".json")).sort()) {
    const file = path.join(dir, entry);
    try {
      const raw = JSON.parse(await fsAsync.readFile(file, "utf-8")) as unknown;
      const skill = parseSkill(raw, file);
      if (skill) skills.push(skill);
    } catch (err) {
      log.warn({ err, file }, "failed to read or parse skill file — skipped");
    }
  }
  return skills;
}
