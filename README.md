# Gemini–GitHub MCP Bridge

A remote Streamable HTTP MCP server for Gemini custom apps, hosted on Render.

## Tools
- `github_list_repositories`
- `github_read_file`
- `github_write_file` (creates a GitHub commit)
- `github_list_workflows`
- `github_dispatch_workflow`
- `github_list_workflow_runs`

## Deploy to a NEW Render service
1. Create a new GitHub repository, e.g. `gemini-github-mcp-bridge`.
2. Upload these project files to its root and commit them.
3. In Render, choose **New + → Blueprint**, connect the new repository, and deploy `render.yaml`.
   Alternatively create a new Web Service with build `npm install`, start `npm start`, health path `/health`.
4. In Render → Environment, set:
   - `GITHUB_TOKEN`: a GitHub fine-grained personal access token.
   - `GITHUB_OWNER`: your GitHub username or organization. This restricts tools to repositories owned by that owner.
   - `MCP_BEARER_TOKEN`: use a long random secret (Render generates one in Blueprint deployments; copy its value).
5. Redeploy if prompted. Test `https://YOUR-SERVICE.onrender.com/health` and expect `{"ok":true}`.

## GitHub token permissions
Use a fine-grained token restricted to the intended repository/repositories. Grant:
- Metadata: Read-only (required)
- Contents: Read and write (file reads and commits)
- Actions: Read and write (list workflows/runs and dispatch workflows)

Do not paste tokens into Gemini chats, source files, or public repositories. Never commit `.env`.

## Gemini connection
Google currently documents custom MCP apps under Gemini Apps → Settings → Connected Apps, but access depends on account eligibility and region. If the Custom apps option is available:
1. Open Gemini on the web.
2. Settings → Connected Apps → Add a custom app.
3. Enter `https://YOUR-SERVICE.onrender.com/mcp`.
4. If asked for credentials, choose bearer-token authentication and provide `MCP_BEARER_TOKEN`.
5. Save and test from Gemini mobile or web using `@` and the connected app's name.

If Gemini's UI does not accept bearer-token credentials or the Custom apps option is unavailable, this endpoint cannot be connected directly through that UI; don't disable authentication to work around it. Use a supported MCP client or wait until the feature is enabled for the account.

## Security notes
- Treat this server as privileged: it can commit files and dispatch workflows.
- Gemini should ask for confirmation before write/dispatch actions; review changes and workflow targets carefully.
- For production use, consider OAuth 2.1, audit logging, rate limits, and repository allowlists.
