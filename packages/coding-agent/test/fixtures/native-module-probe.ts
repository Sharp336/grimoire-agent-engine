import { Type } from "@oh-my-pi/omptype/typebox";
import { loadNativeModule } from "../../src/extensibility/plugins/native-module";

const loaded = (await loadNativeModule(process.argv[2])) as {
	Type: typeof Type;
	asset: string;
	url: string;
	later: () => Promise<{ Type: typeof Type; url: string }>;
	default: (api: {
		typebox: { Type: typeof Type };
		registerTool: (tool: { name: string; parameters: unknown }) => void;
	}) => void;
};
if (loaded.Type !== Type) throw new Error("Extension must share the host schema builder");
if (loaded.asset !== "relative asset" || !loaded.url.endsWith("/nested/helper.ts"))
	throw new Error("Helper file base failed");
const late = await loaded.later();
if (late.Type !== Type || !late.url.endsWith("/nested/late.ts")) throw new Error("Late relative import failed");
const tools: Array<{ name: string; parameters: unknown }> = [];
loaded.default({
	typebox: { Type },
	registerTool: value => {
		tools.push(value);
	},
});
if (tools[0]?.name !== "native" || !tools[0].parameters) throw new Error("Native factory registration failed");
console.log("native-module-ok");
