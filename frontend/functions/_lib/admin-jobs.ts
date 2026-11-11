// Operator jobs, run by the cron from the D1 table `admin_jobs`
// (migration 0005).
//
// A job is a row somebody with access to the Cloudflare account inserts:
//
//   npx wrangler d1 execute hitz-data --remote \
//     --command "INSERT INTO admin_jobs (command) VALUES ('{\"type\":\"recovery-plan\"}')"
//
// The next cron run executes it and writes the result back to the row. No
// HTTP route queues or runs a job, so there is nothing public to find, guess
// a token for, or call in a loop. A privileged action on the sponsor must
// never be reachable from a public endpoint.
//
// One job runs per call, oldest first. While a job is marked `running`
// nothing else starts: a job cut off halfway may have sent a transaction, and
// someone should look before another one does.
//
// Erasable TypeScript without Worker bindings, so tests/admin-jobs.test.mjs
// runs it in Node. The job types live in sponsor-ops.ts.

export type JobHandler = (command: Record<string, unknown>) => Promise<unknown>;

export interface JobOutcome {
  id: number;
  type: string;
  status: "done" | "failed";
}

const CLAIM =
  "UPDATE admin_jobs SET status = 'running', started_at = ?1 " +
  "WHERE id = (SELECT MIN(id) FROM admin_jobs WHERE status = 'pending') " +
  "AND NOT EXISTS (SELECT 1 FROM admin_jobs WHERE status = 'running') " +
  "RETURNING id, command";

function parseCommand(text: string): { type: string } & Record<string, unknown> {
  const command: unknown = JSON.parse(text);
  if (!command || typeof command !== "object" || Array.isArray(command) || typeof (command as { type?: unknown }).type !== "string") {
    throw new Error('a job command is a JSON object with a "type"');
  }
  return command as { type: string } & Record<string, unknown>;
}

/** Run the oldest pending job, if there is one and none is running. */
export async function runNextJob(
  db: D1Database,
  handlers: Record<string, JobHandler>,
  now: Date = new Date()
): Promise<JobOutcome | null> {
  const claimed = await db.prepare(CLAIM).bind(now.toISOString()).first<{ id: number; command: string }>();
  if (!claimed) return null;

  let type = "?";
  let status: JobOutcome["status"] = "done";
  let result: unknown;
  try {
    const command = parseCommand(claimed.command);
    type = command.type;
    if (!Object.hasOwn(handlers, type)) throw new Error(`unknown job type: ${type}`);
    result = await handlers[type](command);
  } catch (err) {
    status = "failed";
    result = { error: err instanceof Error ? err.message : String(err) };
  }
  await db
    .prepare("UPDATE admin_jobs SET status = ?1, result = ?2, finished_at = ?3 WHERE id = ?4")
    .bind(
      status,
      JSON.stringify(result ?? null, (_key, value) => (typeof value === "bigint" ? value.toString() : value)),
      new Date().toISOString(),
      claimed.id
    )
    .run();
  return { id: Number(claimed.id), type, status };
}
