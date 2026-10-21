import express from "express";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = Number(process.env.PORT || 10000);
const MCP_BEARER_TOKEN = process.env.MCP_BEARER_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER || "";

if (!MCP_BEARER_TOKEN || MCP_BEARER_TOKEN.length < 4) {
  throw new Error("MCP_BEARER_TOKEN must be set to a random secret of at least 4 characters.");
}
if (!GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is required.");

const app = express();
app.use(express.json({ limit: "1mb" }));

function safeEqual(a, b) {
  const aa = Buffer.from(a || "");
  const bb = Buffer.from(b || "");
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

function authorize(req, res, next) {
  const header = req.get("authorization") || "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!safeEqual(supplied, MCP_BEARER_TOKEN)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

async function gh(path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers
    }
  });
  const body = await response.text();
  let data;
  try { data = body ? JSON.parse(body) : {}; } catch { data = { raw: body }; }
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status}: ${data.message || body || response.statusText}`);
  }
  return data;
}

function repoName(repo) {
  const value = repo || (GITHUB_OWNER ? `${GITHUB_OWNER}/` : "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error("Repository must be in owner/name format.");
  }
  if (GITHUB_OWNER && value.split("/")[0].toLowerCase() !== GITHUB_OWNER.toLowerCase()) {
    throw new Error(`This server is restricted to repositories owned by ${GITHUB_OWNER}.`);
  }
  return value;
}

function createMcpServer() {
  const server = new McpServer({ name: "gemini-github-bridge", version: "1.0.0" });

server.tool(
  "github_list_repositories",
  "List repositories accessible to the configured GitHub token. If GITHUB_OWNER is set, only that owner's repositories are returned.",
  { visibility: z.enum(["all", "public", "private"]).optional() },
  async ({ visibility = "all" }) => {
    const repos = await gh(`/user/repos?per_page=100&sort=updated&visibility=${visibility}`);
    const filtered = GITHUB_OWNER
      ? repos.filter(r => r.owner?.login?.toLowerCase() === GITHUB_OWNER.toLowerCase())
      : repos;
    return { content: [{ type: "text", text: JSON.stringify(filtered.map(r => ({
      full_name: r.full_name, private: r.private, default_branch: r.default_branch,
      html_url: r.html_url, description: r.description, updated_at: r.updated_at
    })), null, 2) }] };
  }
);

server.tool(
  "github_read_file",
  "Read a text file from a repository branch. Use this to inspect code before proposing or making edits.",
  {
    repo: z.string().describe("owner/name"),
    path: z.string().min(1),
    branch: z.string().optional()
  },
  async ({ repo, path, branch }) => {
    const name = repoName(repo);
    const suffix = branch ? `?ref=${encodeURIComponent(branch)}` : "";
    const file = await gh(`/repos/${name}/contents/${path.split("/").map(encodeURIComponent).join("/")}${suffix}`);
    if (Array.isArray(file)) throw new Error("Path is a directory, not a file.");
    const content = file.encoding === "base64"
      ? Buffer.from(file.content.replace(/\n/g, ""), "base64").toString("utf8")
      : file.content;
    return { content: [{ type: "text", text: JSON.stringify({
      name: file.name, path: file.path, sha: file.sha, html_url: file.html_url,
      content
    }, null, 2) }] };
  }
);

server.tool(
  "github_write_file",
  "Create or update a UTF-8 text file on a branch. This changes the repository and creates a commit. Always read the file first if it may already exist; pass its current SHA when updating. Ask the user for confirmation before calling this tool.",
  {
    repo: z.string().describe("owner/name"),
    path: z.string().min(1),
    content: z.string(),
    message: z.string().min(1),
    branch: z.string().optional(),
    sha: z.string().optional()
  },
  async ({ repo, path, content, message, branch, sha }) => {
    const name = repoName(repo);
    const body = { message, content: Buffer.from(content, "utf8").toString("base64") };
    if (branch) body.branch = branch;
    if (sha) body.sha = sha;
    const result = await gh(`/repos/${name}/contents/${path.split("/").map(encodeURIComponent).join("/")}`, {
      method: "PUT", body: JSON.stringify(body)
    });
    return { content: [{ type: "text", text: JSON.stringify({
      path: result.content?.path, commit_sha: result.commit?.sha,
      html_url: result.content?.html_url, commit_url: result.commit?.html_url
    }, null, 2) }] };
  }
);

server.tool(
  "github_list_workflows",
  "List GitHub Actions workflows in a repository.",
  { repo: z.string().describe("owner/name") },
  async ({ repo }) => {
    const name = repoName(repo);
    const data = await gh(`/repos/${name}/actions/workflows?per_page=100`);
    return { content: [{ type: "text", text: JSON.stringify(data.workflows.map(w => ({
      id: w.id, name: w.name, path: w.path, state: w.state, html_url: w.html_url
    })), null, 2) }] };
  }
);

server.tool(
  "github_dispatch_workflow",
  "Trigger a workflow_dispatch event. The workflow must define workflow_dispatch and the token must have Actions write permission. This starts a real workflow run; ask the user for confirmation before calling.",
  {
    repo: z.string().describe("owner/name"),
    workflow_id: z.union([z.string(), z.number()]).describe("Workflow file name such as test.yml or numeric workflow ID"),
    ref: z.string().describe("Branch or tag to run on"),
    inputs: z.record(z.string()).optional()
  },
  async ({ repo, workflow_id, ref, inputs = {} }) => {
    const name = repoName(repo);
    await gh(`/repos/${name}/actions/workflows/${encodeURIComponent(String(workflow_id))}/dispatches`, {
      method: "POST", body: JSON.stringify({ ref, inputs })
    });
    return { content: [{ type: "text", text: `Workflow dispatch accepted for ${name}, workflow ${workflow_id}, ref ${ref}. Check GitHub Actions for the run.` }] };
  }
);

server.tool(
  "github_list_workflow_runs",
  "List recent GitHub Actions workflow runs for a repository.",
  {
    repo: z.string().describe("owner/name"),
    branch: z.string().optional(),
    per_page: z.number().int().min(1).max(100).optional()
  },
  async ({ repo, branch, per_page = 10 }) => {
    const name = repoName(repo);
    const params = new URLSearchParams({ per_page: String(per_page) });
    if (branch) params.set("branch", branch);
    const data = await gh(`/repos/${name}/actions/runs?${params}`);
    return { content: [{ type: "text", text: JSON.stringify(data.workflow_runs.map(r => ({
      id: r.id, name: r.name, event: r.event, status: r.status,
      conclusion: r.conclusion, head_branch: r.head_branch,
      html_url: r.html_url, created_at: r.created_at
    })), null, 2) }] };
  }
);

  return server;
}


app.get("/", (_req, res) => res.json({
  name: "Gemini–GitHub MCP Bridge",
  status: "ok",
  transport: "Streamable HTTP",
  endpoint: "/mcp"
}));
app.get("/health", (_req, res) => res.status(200).json({ ok: true }));

// Stateless HTTP MCP endpoint. Keep authentication on every request.
app.all("/mcp", authorize, async (req, res) => {
  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });
    const server = createMcpServer();
    res.on("close", () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP request failed:", error?.message || error);
    if (!res.headersSent) res.status(500).json({ error: "MCP request failed" });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Gemini–GitHub MCP bridge listening on port ${PORT}`);
});
