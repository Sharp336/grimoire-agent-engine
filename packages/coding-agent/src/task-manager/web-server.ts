/**
 * Task Manager web UI — server-side rendered HTML + vanilla JS.
 *
 * Follows the omp stats pattern: `Bun.serve` with embedded HTML. No build
 * step, no React, no Tailwind — just server-rendered HTML with fetch-based
 * updates. All text says "Task Manager".
 */

import { openPath } from "../utils/open";
import { generateKanbanBoardWithMetadata } from "./board";
import type { Core } from "./core";

export interface WebServerOptions {
	port: number;
	open?: boolean;
}

export async function startTaskManagerWebServer(core: Core, options: WebServerOptions): Promise<void> {
	const server = Bun.serve({
		port: options.port,
		hostname: "127.0.0.1",
		async fetch(req) {
			const url = new URL(req.url);
			const path = url.pathname;

			// API routes
			if (path.startsWith("/api/")) {
				return handleApiRoute(core, path, req);
			}

			// Main page
			if (path === "/" || path === "/index.html") {
				return new Response(renderPage(), {
					headers: { "content-type": "text/html; charset=utf-8" },
				});
			}

			return new Response("Not found", { status: 404 });
		},
	});

	process.stdout.write(`Task Manager web UI running at http://${server.hostname}:${server.port}\n`);

	if (options.open) {
		openPath(`http://${server.hostname}:${server.port}`);
	}
}

async function handleApiRoute(core: Core, path: string, req: Request): Promise<Response> {
	await core.ensureConfigLoaded();

	if (path === "/api/tasks") {
		const tasks = await core.listTasks();
		return jsonResponse(tasks);
	}

	if (path.startsWith("/api/tasks/")) {
		const id = path.split("/")[3];
		try {
			const task = await core.loadTask(id);
			return jsonResponse(task);
		} catch {
			return new Response("Task not found", { status: 404 });
		}
	}

	if (path === "/api/milestones") {
		const milestones = await core.listMilestones();
		return jsonResponse(milestones);
	}

	if (path === "/api/documents") {
		const docs = await core.listDocuments();
		return jsonResponse(docs);
	}

	if (path === "/api/board") {
		const tasks = await core.listTasks();
		const board = generateKanbanBoardWithMetadata(tasks, core.config.statuses);
		return jsonResponse(board);
	}

	if (path === "/api/create-task" && req.method === "POST") {
		try {
			const body = (await req.json()) as { title: string; description?: string; status?: string };
			const task = await core.createTask({
				title: body.title,
				description: body.description,
				status: body.status,
			});
			return jsonResponse(task, 201);
		} catch (err) {
			return new Response(`Error: ${err instanceof Error ? err.message : String(err)}`, { status: 400 });
		}
	}

	return new Response("Not found", { status: 404 });
}

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
		},
	});
}

function renderPage(): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Task Manager</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #1a1a2e; color: #e0e0e0; }
header { background: #16213e; padding: 1rem 2rem; border-bottom: 1px solid #0f3460; }
header h1 { font-size: 1.5rem; color: #e94560; }
.container { display: flex; gap: 1rem; padding: 1rem; overflow-x: auto; }
.column { min-width: 250px; background: #16213e; border-radius: 8px; padding: 0.5rem; }
.column h2 { font-size: 0.9rem; text-transform: uppercase; color: #8a8a9a; margin-bottom: 0.5rem; padding: 0.5rem; }
.task-card { background: #1a1a2e; border: 1px solid #0f3460; border-radius: 6px; padding: 0.75rem; margin-bottom: 0.5rem; cursor: pointer; }
.task-card:hover { border-color: #e94560; }
.task-card .id { font-size: 0.75rem; color: #8a8a9a; }
.task-card .title { font-size: 0.9rem; margin-top: 0.25rem; }
.task-detail { position: fixed; right: 0; top: 0; height: 100vh; width: 400px; background: #16213e; padding: 2rem; overflow-y: auto; transform: translateX(100%); transition: transform 0.3s; }
.task-detail.open { transform: translateX(0); }
.task-detail h2 { color: #e94560; margin-bottom: 1rem; }
.task-detail .field { margin-bottom: 0.75rem; }
.task-detail .label { font-size: 0.75rem; color: #8a8a9a; text-transform: uppercase; }
.task-detail .value { font-size: 0.9rem; }
.create-form { margin: 1rem 2rem; }
.create-form input, .create-form textarea { background: #16213e; border: 1px solid #0f3460; color: #e0e0e0; padding: 0.5rem; border-radius: 4px; width: 300px; }
.create-form button { background: #e94560; color: white; border: none; padding: 0.5rem 1rem; border-radius: 4px; cursor: pointer; }
</style>
</head>
<body>
<header><h1>Task Manager — powered by Oh My Pi</h1></header>
<div class="create-form">
<input type="text" id="new-title" placeholder="Task title...">
<button onclick="createTask()">Create Task</button>
</div>
<div class="container" id="board"></div>
<div class="task-detail" id="detail">
<span style="cursor:pointer" onclick="closeDetail()">&times; Close</span>
<div id="detail-content"></div>
</div>
<script>
function escapeHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
async function loadBoard() {
const res = await fetch('/api/board');
const board = await res.json();
const el = document.getElementById('board');
el.innerHTML = '';
for (const col of board.columns) {
const colEl = document.createElement('div');
colEl.className = 'column';
colEl.innerHTML = '<h2>' + escapeHtml(col.status) + ' (' + col.tasks.length + ')</h2>';
for (const task of col.tasks) {
const card = document.createElement('div');
card.className = 'task-card';
card.innerHTML = '<div class="id">' + escapeHtml(task.id) + '</div><div class="title">' + escapeHtml(task.title) + '</div>';
card.onclick = () => showDetail(task.id);
colEl.appendChild(card);
}
el.appendChild(colEl);
}
}
async function showDetail(id) {
const res = await fetch('/api/tasks/' + id);
const task = await res.json();
const el = document.getElementById('detail-content');
el.innerHTML = '<h2>' + escapeHtml(task.title) + '</h2>' +
'<div class="field"><div class="label">ID</div><div class="value">' + escapeHtml(task.id) + '</div></div>' +
'<div class="field"><div class="label">Status</div><div class="value">' + escapeHtml(task.status) + '</div></div>' +
'<div class="field"><div class="label">Description</div><div class="value">' + escapeHtml(task.description || '—') + '</div></div>' +
'<div class="field"><div class="label">Assignee</div><div class="value">' + escapeHtml(task.assignee || '—') + '</div></div>' +
'<div class="field"><div class="label">Created</div><div class="value">' + new Date(task.createdAt).toLocaleString() + '</div></div>';
document.getElementById('detail').classList.add('open');
}
function closeDetail() { document.getElementById('detail').classList.remove('open'); }
async function createTask() {
const title = document.getElementById('new-title').value.trim();
if (!title) return;
await fetch('/api/create-task', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ title }) });
document.getElementById('new-title').value = '';
loadBoard();
}
loadBoard();
</script>
</body>
</html>`;
}
