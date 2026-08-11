import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { AutocompleteProvider } from "@oh-my-pi/pi-tui";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("rpc-ui-surfaces", {
		description: "Exercise negotiated rpc-ui surfaces",
		handler: async (_args, ctx) => {
			const unsubscribe = ctx.ui.onTerminalInput(data => {
				if (data === "rpc-ui-raw") return { data: "rpc-ui-transformed", consume: true };
				return undefined;
			});
			ctx.ui.setEditorText("extension-owned draft");
			ctx.ui.setWidget("rpc-ui-widget", () => ({ render: () => ["widget row", "widget\tvalue"] }), {
				placement: "aboveEditor",
			});
			ctx.ui.setHeader(() => ({ render: () => ["header row"] }));
			ctx.ui.setFooter(() => ({ render: () => ["footer row"] }));
			ctx.ui.setTitle("rpc-ui negotiated title");
			ctx.ui.setToolsExpanded(true);
			ctx.ui.addAutocompleteProvider(
				current =>
					({
						...current,
						async getSuggestions(lines, cursorLine, cursorCol) {
							const line = lines[cursorLine] ?? "";
							if (line.slice(0, cursorCol).endsWith("@rpc-ui-hang")) {
								return Promise.withResolvers<never>().promise;
							}
							if (line.slice(0, cursorCol).endsWith("@rpc-ui")) {
								return { items: [{ value: "surface", label: "RPC UI extension" }], prefix: "@rpc-ui" };
							}
							return current.getSuggestions(lines, cursorLine, cursorCol);
						},
						applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
							if (prefix !== "@rpc-ui")
								return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
							const updated = [...lines];
							const line = updated[cursorLine] ?? "";
							const start = cursorCol - prefix.length;
							updated[cursorLine] = `${line.slice(0, start)}${item.value}${line.slice(cursorCol)}`;
							return { lines: updated, cursorLine, cursorCol: start + item.value.length };
						},
					}) satisfies AutocompleteProvider,
			);
			try {
				await ctx.ui.custom<string>((_tui, _theme, _keybindings, done) => ({
					render: () => ["custom row"],
					handleInput: data => {
						if (data === "enter") done("completed");
					},
				}));
			} finally {
				unsubscribe();
			}
		},
	});
}
