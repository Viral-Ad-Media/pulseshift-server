import pg from "pg";
const TABLES = new Set([
  "users",
  "organizations",
  "memberships",
  "requests",
  "invitations",
  "request_events",
  "ai_events",
]);
const FUNCTIONS = new Set([
  "pulse_signup",
  "pulse_provision_workspace",
  "pulse_revoke_sessions",
  "pulse_create_request",
  "pulse_update_request",
  "pulse_cancel_request",
  "pulse_create_invitation",
  "pulse_revoke_invitation",
  "pulse_accept_invitation",
  "pulse_manage_member",
  "pulse_reserve_ai",
  "pulse_finish_ai",
  "pulse_schema_ready",
]);
const identifier = (value) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(value))
    throw new Error("Invalid database identifier");
  return `"${value}"`;
};
export function createPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString)
    throw new Error("DATABASE_URL must point to the Neon PostgreSQL database.");
  const url = new URL(connectionString);
  if (!["postgres:", "postgresql:"].includes(url.protocol))
    throw new Error("DATABASE_URL must be a PostgreSQL URL");
  if (url.hostname.endsWith(".neon.tech")) {
    url.searchParams.set("sslmode", "verify-full");
  }
  return new pg.Pool({
    connectionString: url.toString(),
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
  });
}
export function createDatabase(pool) {
  return {
    pool,
    async rpc(name, args = {}) {
      if (!FUNCTIONS.has(name))
        throw new Error("Unknown application database function");
      const keys = Object.keys(args);
      try {
        const result = await pool.query(
          `select public.${identifier(name)}(${keys.map((key, i) => `${identifier(key)} => $${i + 1}`).join(",")}) as result`,
          Object.values(args),
        );
        return { data: result.rows[0]?.result };
      } catch (error) {
        return { error };
      }
    },
    from(table) {
      if (!TABLES.has(table)) throw new Error("Unknown application table");
      let columns = "*",
        conditions = [],
        values = [],
        sort = "",
        cap = "";
      const builder = {
        select(cols) {
          columns =
            cols === "*"
              ? "*"
              : cols
                  .split(",")
                  .map((v) => identifier(v.trim()))
                  .join(",");
          return builder;
        },
        eq(key, value) {
          values.push(value);
          conditions.push(`${identifier(key)}=$${values.length}`);
          return builder;
        },
        in(key, list) {
          if (!list.length) {
            conditions.push("false");
            return builder;
          }
          conditions.push(
            `${identifier(key)} in (${list
              .map((value) => {
                values.push(value);
                return "$" + values.length;
              })
              .join(",")})`,
          );
          return builder;
        },
        is(key, value) {
          if (value !== null)
            throw new Error("Only null predicates are supported");
          conditions.push(`${identifier(key)} is null`);
          return builder;
        },
        order(key, { ascending = true } = {}) {
          sort = ` order by ${identifier(key)} ${ascending ? "asc" : "desc"}`;
          return builder;
        },
        limit(n) {
          if (!Number.isSafeInteger(n) || n < 1 || n > 1000)
            throw new Error("Invalid query limit");
          cap = ` limit ${n}`;
          return builder;
        },
        async then(resolve, reject) {
          try {
            const result = await pool.query(
              `select ${columns} from public.${identifier(table)}${conditions.length ? " where " + conditions.join(" and ") : ""}${sort}${cap}`,
              values,
            );
            return resolve({ data: result.rows });
          } catch (error) {
            return resolve({ error });
          }
        },
      };
      return builder;
    },
  };
}
