const MAX_INT = 2_147_483_647;

// Same padding as the generated tasks.code column: at least 4 digits.
const pad = (n: number) => String(n).padStart(4, '0');

/** (42, 137) -> PRJ-0042-T-0137, the same text as the generated column. */
export function taskCode(projectId: number, number: number): string {
  return `PRJ-${pad(projectId)}-T-${pad(number)}`;
}

/**
 * PRJ-0042-T-0137 -> { projectId: 42, number: 137 }, so lookups hit the
 * (project_id, number) unique index instead of filtering on the code text.
 *
 * Only the exact form the database generates is accepted, so lookups stay
 * exact match like before: lowercase, missing or extra zeros all give null.
 */
export function parseTaskCode(code: string): { projectId: number; number: number } | null {
  const m = /^PRJ-(\d{4,10})-T-(\d{4,10})$/.exec(code);
  if (!m) return null;
  const projectId = Number(m[1]);
  const number = Number(m[2]);
  if (projectId > MAX_INT || number > MAX_INT) return null;
  if (code !== taskCode(projectId, number)) return null;
  return { projectId, number };
}

/** The task number of `code` if it names a task of `projectId`, else null. */
export function taskNumberIn(projectId: number, code: string): number | null {
  const parsed = parseTaskCode(code);
  return parsed?.projectId === projectId ? parsed.number : null;
}
