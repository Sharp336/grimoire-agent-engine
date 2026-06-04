import { describe, expect, test } from "bun:test";
import { applyNotebookEditableText, type NotebookDocument, notebookToEditableText } from "../src/edit/notebook";

function makeNotebook(cells: NotebookDocument["cells"]): NotebookDocument {
	return { cells, metadata: {}, nbformat: 4, nbformat_minor: 5 };
}

function sourceText(cell: NotebookDocument["cells"][number]): string {
	const { source } = cell;
	if (source === undefined) return "";
	return typeof source === "string" ? source : source.join("");
}

describe("notebook editable-text round-trip", () => {
	test("preserves a cell whose source contains a line that looks like a cell marker", () => {
		// A markdown/doc cell that quotes the percent-cell syntax. Before the fix
		// this line was parsed back as a real cell boundary, splitting the cell
		// and dropping the quoted line.
		const notebook = makeNotebook([
			{
				cell_type: "markdown",
				source: ["Start a cell with:\n", "# %% [code]\n", "and write code below.\n"],
				metadata: { tag: "intro" },
			},
			{
				cell_type: "code",
				source: ["print('second cell')\n"],
				metadata: {},
				execution_count: 7,
				outputs: [{ output_type: "stream", text: "second cell\n" }],
			},
		]);

		const editable = notebookToEditableText(notebook);
		const roundTripped = applyNotebookEditableText(notebook, editable, "demo.ipynb");

		// Cell count is unchanged: the marker-like body line did not split the cell.
		expect(roundTripped.cells).toHaveLength(2);

		// The first cell keeps its type, full source (including the quoted marker
		// line), and metadata.
		expect(roundTripped.cells[0].cell_type).toBe("markdown");
		expect(sourceText(roundTripped.cells[0])).toBe("Start a cell with:\n# %% [code]\nand write code below.\n");
		expect(roundTripped.cells[0].metadata).toEqual({ tag: "intro" });

		// The second cell is untouched: its execution count and outputs survive,
		// confirming nothing shifted onto the wrong original cell.
		expect(roundTripped.cells[1].cell_type).toBe("code");
		expect(sourceText(roundTripped.cells[1])).toBe("print('second cell')\n");
		expect(roundTripped.cells[1].execution_count).toBe(7);
		expect(roundTripped.cells[1].outputs).toEqual([{ output_type: "stream", text: "second cell\n" }]);
	});

	test("handles a source line that already starts with the escape character", () => {
		// Content that itself begins with `\# %% [code]` must survive verbatim
		// (escape-the-escape), and a leading backslash on an ordinary line must
		// not be stripped.
		const notebook = makeNotebook([
			{
				cell_type: "code",
				source: ["\\# %% [code]\n", "\\n is a newline\n", "# %% [raw] cell:3\n"],
				metadata: {},
			},
		]);

		const editable = notebookToEditableText(notebook);
		const roundTripped = applyNotebookEditableText(notebook, editable, "demo.ipynb");

		expect(roundTripped.cells).toHaveLength(1);
		expect(sourceText(roundTripped.cells[0])).toBe("\\# %% [code]\n\\n is a newline\n# %% [raw] cell:3\n");
	});

	test("still allows adding a new cell via an unindexed marker", () => {
		// The unindexed `# %% [code]` form remains a supported way for an edit to
		// introduce a brand-new cell; only marker-like *body* lines are escaped.
		const notebook = makeNotebook([{ cell_type: "code", source: ["a = 1\n"], metadata: {} }]);
		const edited = "# %% [code] cell:0\na = 1\n# %% [markdown]\nnew cell\n";
		const roundTripped = applyNotebookEditableText(notebook, edited, "demo.ipynb");

		expect(roundTripped.cells).toHaveLength(2);
		expect(roundTripped.cells[1].cell_type).toBe("markdown");
		expect(sourceText(roundTripped.cells[1])).toBe("new cell\n");
	});
});
