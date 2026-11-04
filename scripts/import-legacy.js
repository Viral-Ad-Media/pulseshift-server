import "dotenv/config";
import { createPool } from "../database.js";
// Copy only app-owned tables into a new, already-migrated target. Never deletes source/target data.
const TABLES = [
  "organizations",
  "users",
  "memberships",
  "requests",
  "invitations",
  "request_events",
  "ai_events",
];
const quote = (value) => '"' + value.replaceAll('"', '""') + '"';
export async function importLegacy(sourcePool, targetPool) {
  const source = await sourcePool.connect(),
    target = await targetPool.connect();
  const counts = {};
  try {
    await source.query("begin isolation level repeatable read read only");
    await target.query("begin");
    for (const table of [...TABLES, "auth_users"]) {
      const result = await target.query(
        `select count(*)::int as n from public.${quote(table)}`,
      );
      if (result.rows[0].n)
        throw new Error(
          "Import requires an empty, freshly migrated target database.",
        );
    }
    for (const table of TABLES) {
      const exists = await source.query("select to_regclass($1) as name", [
        "public." + table,
      ]);
      if (!exists.rows[0].name) continue;
      const srcColumns = (
        await source.query(
          "select column_name from information_schema.columns where table_schema=$1 and table_name=$2 order by ordinal_position",
          ["public", table],
        )
      ).rows.map((r) => r.column_name);
      const dstColumns = new Set(
        (
          await target.query(
            "select column_name from information_schema.columns where table_schema=$1 and table_name=$2",
            ["public", table],
          )
        ).rows.map((r) => r.column_name),
      );
      const columns = srcColumns.filter((c) => dstColumns.has(c));
      const order = table === "memberships" ? "user_id,org_id" : "id";
      let offset = 0;
      while (true) {
        const page = await source.query(
          `select ${columns.map(quote).join(",")} from public.${quote(table)} order by ${order} limit 500 offset $1`,
          [offset],
        );
        if (!page.rows.length) break;
        for (const row of page.rows)
          await target.query(
            `insert into public.${quote(table)}(${columns.map(quote).join(",")}) overriding system value values(${columns.map((_, i) => "$" + (i + 1)).join(",")})`,
            columns.map((c) => row[c]),
          );
        offset += page.rows.length;
      }
      counts[table] = offset;
    }
    await target.query(
      "select setval(pg_get_serial_sequence('public.request_events','id'),coalesce(max(id),1),max(id) is not null) from public.request_events",
    );
    await target.query("select public.pulse_import_legacy_accounts()");
    await target.query("commit");
    await source.query("commit");
    return counts;
  } catch (error) {
    await target.query("rollback");
    await source.query("rollback");
    throw error;
  } finally {
    source.release();
    target.release();
  }
}
if (
  process.env.SOURCE_DATABASE_URL &&
  process.env.IMPORT_LEGACY_DATA === "yes"
) {
  const source = createPool(process.env.SOURCE_DATABASE_URL),
    target = createPool(
      process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL,
    );
  try {
    console.log(await importLegacy(source, target));
  } finally {
    await source.end();
    await target.end();
  }
} else if (process.argv[1]?.endsWith("import-legacy.js")) {
  throw new Error(
    "Set SOURCE_DATABASE_URL, DATABASE_URL_UNPOOLED and IMPORT_LEGACY_DATA=yes to import into an empty target.",
  );
}
