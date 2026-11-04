import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
// pg-compatible transport for real Better Auth + SQL integration tests.
export async function testDatabase() {
  const engine = new PGlite();
  const pool = {
    async query(sql, values) {
      const input = typeof sql === "string" ? sql : sql.text;
      const parameters =
        values || (typeof sql === "object" ? sql.values : undefined);
      const result = parameters
        ? await engine.query(input, parameters)
        : (await engine.exec(input)).at(-1);
      return {
        rows: result.rows,
        rowCount: result.affectedRows ?? result.rows.length,
        command:
          typeof sql === "string"
            ? sql.trim().split(/\s+/)[0].toUpperCase()
            : undefined,
      };
    },
    async connect() {
      return { query: pool.query, release() {} };
    },
    async end() {
      await engine.close();
    },
    on() {
      return pool;
    },
  };
  // Multi-statement migrations use exec; application queries use query.
  for (const file of ["db/schema.sql", "db/migrations/20261005_audit.sql"])
    await engine.exec(await readFile(file, "utf8"));
  return { pool, engine };
}
