import { describe, expect, it } from "vitest";
import { summarizeSql } from "../src/sql.ts";
import { toUrlPath } from "../src/nextjs.ts";
import { inlineScriptText } from "../src/project.ts";
import { joinUrlPath, packageName, camelFromBasename } from "../src/util.ts";
import { parseNginx } from "../src/infra.ts";

describe("summarizeSql", () => {
  it.each([
    ["SELECT * FROM payments WHERE id = $1 AND merchant_id = $2", "SELECT payments", { singleRow: true, hasLimit: false }],
    ["select follower_id from follows where followee_id = $1", "SELECT follows", { singleRow: false, hasLimit: false }],
    ["INSERT INTO jobs (type) VALUES ($1) RETURNING *", "INSERT jobs", {}],
    ["UPDATE jobs SET status = 'x' WHERE id = $1", "UPDATE jobs", { singleRow: true }],
    ["DELETE FROM likes WHERE user_id = $1", "DELETE likes", {}],
    ["SELECT status, count(*)::int AS count FROM jobs GROUP BY status", "SELECT jobs", { aggregate: true }],
    ["SELECT * FROM jobs ORDER BY id DESC LIMIT $1 OFFSET $2", "SELECT jobs", { hasLimit: true }],
    ["BEGIN", "BEGIN", {}],
    ["-- comment\nWITH x AS (SELECT 1) SELECT * FROM x", "SELECT x", {}],
  ])("%s", (sql, label, flags) => {
    const s = summarizeSql(sql);
    expect(s.label).toBe(label);
    expect(s).toMatchObject(flags);
  });
});

describe("helpers", () => {
  it("maps Next.js folders to URL paths", () => {
    expect(toUrlPath("")).toBe("/");
    expect(toUrlPath("api/posts/[id]")).toBe("/api/posts/:id");
    expect(toUrlPath("(marketing)/blog/[...slug]")).toBe("/blog/:slug*");
    expect(toUrlPath("@modal/photos/[[...rest]]")).toBe("/photos/:rest*");
  });

  it("keeps inline script line and column positions", () => {
    const html = "<html>\n<body>\n<script>\nconst a = 1;\nfetch('/x');\n</script>\n<script src=\"x.js\"></script>\n</body>";
    const js = inlineScriptText(html)!;
    expect(js.split("\n")[4]).toBe("fetch('/x');");
    expect(js.split("\n").length).toBe(html.split("\n").length);
    expect(inlineScriptText("<p>no scripts</p>")).toBeUndefined();
  });

  it("joins URL paths", () => {
    expect(joinUrlPath("/payments", "/")).toBe("/payments");
    expect(joinUrlPath("", "/")).toBe("/");
    expect(joinUrlPath("/api/", "/users/:id")).toBe("/api/users/:id");
  });

  it("names things", () => {
    expect(packageName("@aws-sdk/client-s3/dist")).toBe("@aws-sdk/client-s3");
    expect(packageName("node:crypto")).toBe("crypto");
    expect(camelFromBasename("auth.service")).toBe("authService");
  });

  it("reads nginx proxy config", () => {
    const p = parseNginx("nginx.conf", "http {\n limit_req_zone $x zone=a:10m rate=10r/s;\n upstream app { server app:4000; }\n server {\n  listen 80;\n  location / { proxy_pass http://app; }\n }\n}");
    expect(p).toMatchObject({ upstreams: ["app:4000"], rateLimit: "10r/s", listen: { line: 5 }, proxyPass: { line: 6 } });
  });
});
