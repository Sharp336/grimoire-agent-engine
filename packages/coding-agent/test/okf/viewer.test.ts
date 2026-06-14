import { describe, expect, it } from "bun:test";
import type { OkfGraph } from "../../src/okf/bundle";
import { generateViewer } from "../../src/okf/viewer/generator";

const sampleGraph: OkfGraph = {
	nodes: [
		{ id: "tables/orders", type: "Table", title: "Orders", description: "order data", tags: ["sales"] },
		{ id: "tables/customers", type: "Table", title: "Customers", description: "customer data", tags: ["crm"] },
		{ id: "playbooks/incident", type: "Playbook", description: "incident response", tags: ["oncall"] },
	],
	edges: [
		{ from: "tables/orders", to: "tables/customers" },
		{ from: "tables/customers", to: "tables/orders" },
	],
};

describe("okf/viewer.generateViewer", () => {
	it("produces valid HTML with DOCTYPE", () => {
		const html = generateViewer(sampleGraph);
		expect(html).toContain("<!DOCTYPE html>");
		expect(html).toContain("<html");
		expect(html).toContain("</html>");
		expect(html).toContain("<head>");
		expect(html).toContain("<body>");
	});

	it("contains the graph data as JSON", () => {
		const html = generateViewer(sampleGraph);
		expect(html).toContain('"nodes"');
		expect(html).toContain('"edges"');
		expect(html).toContain("tables/orders");
		expect(html).toContain("tables/customers");
		expect(html).toContain("playbooks/incident");
	});

	it("has no external network references", () => {
		const html = generateViewer(sampleGraph);
		// No external script sources
		expect(html).not.toMatch(/<script\s+src=/);
		// No external stylesheet links
		expect(html).not.toMatch(/<link\s+[^>]*href=/);
		// No CDN or http references in src/href
		expect(html).not.toMatch(/src=["']https?:\/\//);
		expect(html).not.toMatch(/href=["']https?:\/\//);
	});

	it("inlines CSS and JS", () => {
		const html = generateViewer(sampleGraph);
		expect(html).toContain("<style>");
		expect(html).toContain("</style>");
		expect(html).toContain("<script>");
		expect(html).toContain("</script>");
	});

	it("uses custom title", () => {
		const html = generateViewer(sampleGraph, { title: "My Knowledge" });
		expect(html).toContain("<title>My Knowledge</title>");
		expect(html).toContain("<h1>My Knowledge</h1>");
	});

	it("includes concept count in stats", () => {
		const html = generateViewer(sampleGraph);
		expect(html).toContain("3 concepts");
		expect(html).toContain("2 links");
	});

	it("handles empty graph", () => {
		const html = generateViewer({ nodes: [], edges: [] });
		expect(html).toContain("0 concepts");
		expect(html).toContain("0 links");
	});

	it("contains SVG element for rendering", () => {
		const html = generateViewer(sampleGraph);
		expect(html).toContain("<svg");
	});

	it("contains sidebar for node details", () => {
		const html = generateViewer(sampleGraph);
		expect(html).toContain("node-info");
	});
});
