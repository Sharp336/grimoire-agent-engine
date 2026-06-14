/**
 * Self-contained interactive HTML graph viewer for OKF bundles.
 *
 * Takes the concept graph (nodes + edges from `bundle.buildGraph()`) and
 * produces a single `.html` file that renders an interactive force-directed
 * graph in any browser — no backend, no CDN, no install, no data leaves the
 * page.
 *
 * Concepts are nodes (coloured by `type`); cross-links are directed edges.
 * Hover shows details; click opens the concept's `okf://` URL.
 *
 * Inspired by the OKF reference `viewer/` but rewritten cleanly in TS with
 * vanilla SVG + a lightweight spring layout (no D3).
 */

import type { OkfGraph } from "../bundle";

/**
 * Generate a self-contained HTML viewer for an OKF concept graph.
 *
 * @param graph The concept graph (nodes + edges).
 * @param options Optional title for the page.
 * @returns A complete HTML string that can be written to a `.html` file.
 */
export function generateViewer(graph: OkfGraph, options: { title?: string } = {}): string {
	const title = options.title ?? "OKF Knowledge Graph";
	const data = JSON.stringify(graph).replace(/</g, "\\u003c");

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
${CSS}
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(title)}</h1>
  <p id="stats">${graph.nodes.length} concepts · ${graph.edges.length} links</p>
</header>
<main>
  <svg id="graph" xmlns="http://www.w3.org/2000/svg"></svg>
  <aside id="sidebar">
    <div id="node-info"><p class="hint">Click a node to see details.</p></div>
  </aside>
</main>
<script id="graph-data" type="application/json">${data}</script>
<script>
${JS}
</script>
</body>
</html>`;
}

/** Escape HTML special characters in user-facing strings. */
function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ─────────────────────────────────────────────────────────────────────────────
// CSS (inlined into the output HTML)
// ─────────────────────────────────────────────────────────────────────────────

const CSS = `
* { margin: 0; padding: 0; box-sizing: border-box; }

:root {
  --bg: #0d1117;
  --surface: #161b22;
  --border: #30363d;
  --text: #e6edf3;
  --text-muted: #8b949e;
  --accent: #58a6ff;
}

body {
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

header {
  padding: 12px 20px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: baseline;
  gap: 16px;
}

header h1 { font-size: 18px; font-weight: 600; }
#stats { color: var(--text-muted); font-size: 13px; }

main {
  flex: 1;
  display: flex;
  overflow: hidden;
}

#graph {
  flex: 1;
  cursor: grab;
}
#graph:active { cursor: grabbing; }

#sidebar {
  width: 320px;
  background: var(--surface);
  border-left: 1px solid var(--border);
  overflow-y: auto;
  padding: 16px;
}

#node-info .hint { color: var(--text-muted); font-size: 13px; }
#node-info h2 { font-size: 15px; margin-bottom: 8px; }
#node-info .meta { font-size: 12px; color: var(--text-muted); margin-bottom: 8px; }
#node-info .desc { font-size: 13px; line-height: 1.5; }
#node-info .tags { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 4px; }
#node-info .tag {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 11px;
}

.node-circle {
  stroke-width: 2;
  cursor: pointer;
  transition: stroke-width 0.15s;
}
.node-circle:hover { stroke-width: 3; }

.node-label {
  fill: var(--text-muted);
  font-size: 11px;
  pointer-events: none;
  text-anchor: middle;
}

.edge-line {
  stroke: var(--border);
  stroke-width: 1;
  fill: none;
}
`;

// ─────────────────────────────────────────────────────────────────────────────
// JavaScript (inlined into the output HTML)
// ─────────────────────────────────────────────────────────────────────────────

const JS = `
(function() {
  "use strict";

  var data = JSON.parse(document.getElementById("graph-data").textContent);
  var nodes = data.nodes;
  var edges = data.edges;
  var svg = document.getElementById("graph");
  var infoPanel = document.getElementById("node-info");

  // Type → colour palette.
  var typeColours = [
    "#58a6ff", "#f778ba", "#7ee787", "#ffa657",
    "#bc8cff", "#79c0ff", "#d2a8ff", "#56d364",
    "#f0883e", "#a5d6ff"
  ];
  var typeMap = {};
  var typeIdx = 0;
  function colourFor(type) {
    if (!typeMap[type]) typeMap[type] = typeColours[typeIdx++ % typeColours.length];
    return typeMap[type];
  }

  var width = svg.clientWidth;
  var height = svg.clientHeight;

  // Build node lookup + adjacency.
  var nodeMap = {};
  nodes.forEach(function(n) {
    nodeMap[n.id] = n;
    n.degree = 0;
  });
  edges.forEach(function(e) {
    if (nodeMap[e.from]) nodeMap[e.from].degree++;
    if (nodeMap[e.to]) nodeMap[e.to].degree++;
  });

  // Initialise positions in a circle.
  var cx = width / 2, cy = height / 2;
  var radius = Math.min(width, height) * 0.35;
  nodes.forEach(function(n, i) {
    var angle = (i / nodes.length) * 2 * Math.PI;
    n.x = cx + Math.cos(angle) * radius + (Math.random() - 0.5) * 50;
    n.y = cy + Math.sin(angle) * radius + (Math.random() - 0.5) * 50;
    n.vx = 0;
    n.vy = 0;
  });

  // Force simulation parameters.
  var REPULSION = 8000;
  var SPRING = 0.04;
  var SPRING_LENGTH = 120;
  var CENTER = 0.01;
  var DAMPING = 0.85;
  var MAX_SPEED = 30;

  function simulate() {
    // Repulsive forces (all pairs).
    for (var i = 0; i < nodes.length; i++) {
      for (var j = i + 1; j < nodes.length; j++) {
        var dx = nodes[i].x - nodes[j].x;
        var dy = nodes[i].y - nodes[j].y;
        var dist2 = dx * dx + dy * dy;
        if (dist2 < 1) dist2 = 1;
        var force = REPULSION / dist2;
        var dist = Math.sqrt(dist2);
        var fx = (dx / dist) * force;
        var fy = (dy / dist) * force;
        nodes[i].vx += fx;
        nodes[i].vy += fy;
        nodes[j].vx -= fx;
        nodes[j].vy -= fy;
      }
    }

    // Attractive forces (edges = springs).
    edges.forEach(function(e) {
      var a = nodeMap[e.from], b = nodeMap[e.to];
      if (!a || !b) return;
      var dx = b.x - a.x;
      var dy = b.y - a.y;
      var dist = Math.sqrt(dx * dx + dy * dy) || 1;
      var force = SPRING * (dist - SPRING_LENGTH);
      var fx = (dx / dist) * force;
      var fy = (dy / dist) * force;
      a.vx += fx; a.vy += fy;
      b.vx -= fx; b.vy -= fy;
    });

    // Center gravity + integrate.
    nodes.forEach(function(n) {
      n.vx += (cx - n.x) * CENTER;
      n.vy += (cy - n.y) * CENTER;
      n.vx *= DAMPING;
      n.vy *= DAMPING;
      var speed = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
      if (speed > MAX_SPEED) {
        n.vx = (n.vx / speed) * MAX_SPEED;
        n.vy = (n.vy / speed) * MAX_SPEED;
      }
      n.x += n.vx;
      n.y += n.vy;
    });
  }

  // SVG rendering.
  var edgeLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
  var nodeLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
  svg.appendChild(edgeLayer);
  svg.appendChild(nodeLayer);

  var edgeEls = [];
  edges.forEach(function(e) {
    var line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("class", "edge-line");
    edgeLayer.appendChild(line);
    edgeEls.push(line);
  });

  var nodeEls = nodes.map(function(n) {
    var g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    var circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    var r = 6 + Math.min(n.degree * 2, 16);
    circle.setAttribute("r", r);
    circle.setAttribute("class", "node-circle");
    circle.setAttribute("fill", colourFor(n.type));
    circle.setAttribute("stroke", "rgba(255,255,255,0.2)");
    g.appendChild(circle);

    var label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("class", "node-label");
    label.setAttribute("y", r + 14);
    var name = n.title || n.id.split("/").pop() || n.id;
    label.textContent = name.length > 20 ? name.slice(0, 18) + "…" : name;
    g.appendChild(label);

    circle.addEventListener("click", function() { showInfo(n); });
    g._node = n;
    nodeLayer.appendChild(g);
    return g;
  });

  function render() {
    nodeEls.forEach(function(el, i) {
      el.setAttribute("transform", "translate(" + nodes[i].x + "," + nodes[i].y + ")");
    });
    edgeEls.forEach(function(el, i) {
      var a = nodeMap[edges[i].from], b = nodeMap[edges[i].to];
      if (!a || !b) return;
      el.setAttribute("x1", a.x);
      el.setAttribute("y1", a.y);
      el.setAttribute("x2", b.x);
      el.setAttribute("y2", b.y);
    });
  }

  function showInfo(n) {
    var name = n.title || n.id.split("/").pop() || n.id;
    var tagsHtml = (n.tags || []).map(function(t) {
      return '<span class="tag">' + escapeHtmlJs(t) + '</span>';
    }).join("");
    infoPanel.innerHTML =
      '<h2>' + escapeHtmlJs(name) + '</h2>' +
      '<p class="meta">Type: ' + escapeHtmlJs(n.type) + ' · ID: ' + escapeHtmlJs(n.id) + '</p>' +
      '<p class="desc">' + escapeHtmlJs(n.description || "") + '</p>' +
      (tagsHtml ? '<div class="tags">' + tagsHtml + '</div>' : '');
  }

  function escapeHtmlJs(text) {
    return String(text).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  }

  // Pan + zoom.
  var viewBox = { x: 0, y: 0, w: width, h: height };
  var dragging = false, dragStart = null;
  svg.addEventListener("mousedown", function(e) {
    dragging = true;
    dragStart = { x: e.clientX, y: e.clientY, vbx: viewBox.x, vby: viewBox.y };
  });
  window.addEventListener("mousemove", function(e) {
    if (!dragging) return;
    viewBox.x = dragStart.vbx - (e.clientX - dragStart.x);
    viewBox.y = dragStart.vby - (e.clientY - dragStart.y);
    svg.setAttribute("viewBox", viewBox.x + " " + viewBox.y + " " + viewBox.w + " " + viewBox.h);
  });
  window.addEventListener("mouseup", function() { dragging = false; });

  svg.addEventListener("wheel", function(e) {
    e.preventDefault();
    var scale = e.deltaY > 0 ? 1.1 : 0.9;
    viewBox.w *= scale;
    viewBox.h *= scale;
    svg.setAttribute("viewBox", viewBox.x + " " + viewBox.y + " " + viewBox.w + " " + viewBox.h);
  });

  // Animation loop.
  var iterations = 0;
  var maxIterations = 500;
  function tick() {
    simulate();
    render();
    iterations++;
    if (iterations < maxIterations) {
      requestAnimationFrame(tick);
    }
  }
  tick();
})();
`;
