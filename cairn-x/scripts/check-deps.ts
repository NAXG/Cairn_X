import path from "node:path";
import { isBuiltin } from "node:module";
import { fileURLToPath } from "node:url";
import { API } from "typescript/unstable/sync";
import * as ts from "typescript/unstable/ast";

const root = fileURLToPath(new URL("../", import.meta.url));
const sourceRoot = path.join(root, "src");
const loopFile = path.join(sourceRoot, "scheduler/loop.ts");
const cliFile = path.join(sourceRoot, "cli.ts");
const cliRoot = path.join(sourceRoot, "cli");
const testsRoot = path.join(root, "tests");
const webRoot = path.join(sourceRoot, "web");
const loopExports = new Set(["DispatcherLoop", "DispatcherLoopOptions"]);

interface Edge {
	from: string;
	to: string;
	node: ts.Node;
	runtime: boolean;
	/** Only named imports may consume the loop's public entry points. */
	loopNames?: string[];
}

function within(file: string, directory: string): boolean {
	const relative = path.relative(directory, file);
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function display(file: string): string {
	return path.relative(root, file).split(path.sep).join("/");
}

let violations = 0;
function report(rule: string, node: ts.Node, message: string): void {
	const source = node.getSourceFile();
	const { line, character } = source.getLineAndCharacterOfPosition(node.getStart());
	console.error(`[${rule}] ${display(source.fileName)}:${line + 1}:${character + 1} ${message}`);
	violations++;
}

// TypeScript 7 exposes ASTs and module symbols through its compiler service.
// A virtual config covers backend, frontend and tests with extensionless resolution.
const configPath = path.join(root, "tsconfig.deps.json");
const configText = JSON.stringify({
	extends: "./tsconfig.json",
	compilerOptions: { module: "ESNext", moduleResolution: "Bundler", jsx: "preserve" },
	include: ["src/**/*", "tests/**/*"],
	exclude: ["**/*.d.ts"],
});
const api = new API({
	cwd: root,
	fs: {
		fileExists: (file) => (file === configPath ? true : undefined),
		readFile: (file) => (file === configPath ? configText : undefined),
	},
});
const edges: Edge[] = [];
/** Node 内置模块依赖；供下方浏览器安全规则判断。 */
const nodeImports: Array<{ file: string; specifier: string; node: ts.Node }> = [];
/** src/web 下的全部文件；浏览器安全规则的 BFS 起点。 */
const webFiles: string[] = [];
let fileCount = 0;
try {
	const snapshot = api.updateSnapshot({ openProjects: [configPath] });
	const project = snapshot.getProject(configPath);
	if (!project) throw new Error("Cannot load dependency-check project");
	const { checker, program } = project;
	const files = project.rootFiles
		.filter((file) => within(file, sourceRoot) || within(file, testsRoot))
		.sort();
	fileCount = files.length;
	for (const file of files) {
		const source = program.getSourceFile(file);
		if (!source) throw new Error(`Cannot parse ${file}`);
		if (within(file, webRoot)) webFiles.push(file);

		function add(
			specifier: ts.StringLiteral,
			node: ts.Node,
			typeOnly: boolean,
			loopNames?: string[],
		): void {
			// 记录 Node 内置模块依赖；type-only 引用会被擦除，不计入浏览器包。
			if (!typeOnly && isBuiltin(specifier.text)) {
				nodeImports.push({ file, specifier: specifier.text, node });
			}
			// The module symbol is resolved by TypeScript, including .js -> .ts,
			// directory imports, extensionless imports and configured path aliases.
			const symbol = checker.getSymbolAtLocation(specifier);
			// NodeHandle.path is case-folded on macOS; use the source filename for edges.
			const target = symbol?.declarations
				.find((declaration) => declaration.kind === ts.SyntaxKind.SourceFile)
				?.resolve()
				?.getSourceFile().fileName;
			if (!target) {
				if (
					specifier.text.startsWith(".") &&
					!/\.(?:css|svg|png|jpe?g|gif|webp|ico|woff2?)(?:\?.*)?$/.test(specifier.text)
				) {
					report("unresolved-import", node, `Cannot resolve ${specifier.text}`);
				}
				return;
			}
			if (!within(target, root) || target.split(path.sep).includes("node_modules")) return;
			edges.push({ from: file, to: target, node, runtime: !typeOnly, loopNames });
		}

		function visit(node: ts.Node): void {
			if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
				const clause = node.importClause;
				const bindings = clause?.namedBindings;
				const named = bindings && ts.isNamedImports(bindings) ? bindings.elements : undefined;
				const typeOnly =
					clause?.phaseModifier === ts.SyntaxKind.TypeKeyword ||
					(!clause?.name && !!named?.length && named.every((entry) => entry.isTypeOnly));
				add(
					node.moduleSpecifier,
					node,
					typeOnly,
					!clause?.name && named
						? named.map((entry) => (entry.propertyName ?? entry.name).text)
						: undefined,
				);
			} else if (
				ts.isExportDeclaration(node) &&
				node.moduleSpecifier &&
				ts.isStringLiteral(node.moduleSpecifier)
			) {
				const named =
					node.exportClause && ts.isNamedExports(node.exportClause)
						? node.exportClause.elements
						: undefined;
				add(
					node.moduleSpecifier,
					node,
					node.isTypeOnly || (!!named?.length && named.every((entry) => entry.isTypeOnly)),
				);
			} else if (
				ts.isImportTypeNode(node) &&
				ts.isLiteralTypeNode(node.argument) &&
				ts.isStringLiteral(node.argument.literal)
			) {
				add(
					node.argument.literal,
					node,
					true,
					node.qualifier && ts.isIdentifier(node.qualifier) ? [node.qualifier.text] : undefined,
				);
			} else if (
				ts.isImportEqualsDeclaration(node) &&
				ts.isExternalModuleReference(node.moduleReference) &&
				node.moduleReference.expression &&
				ts.isStringLiteral(node.moduleReference.expression)
			) {
				add(node.moduleReference.expression, node, node.isTypeOnly);
			} else if (
				ts.isCallExpression(node) &&
				(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
					(ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
				node.arguments[0] &&
				ts.isStringLiteral(node.arguments[0])
			) {
				add(node.arguments[0], node, false);
			}
			node.forEachChild(visit);
		}
		visit(source);

		if (file === loopFile) {
			for (const statement of source.statements) {
				if (ts.isExportDeclaration(statement) || ts.isExportAssignment(statement)) {
					report(
						"loop-exports",
						statement,
						"The loop must not re-export public types or utilities",
					);
				} else if (
					(statement as ts.Statement & Partial<ts.ModifiersBase>).modifiers?.some(
						(modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
					)
				) {
					if (!(
						(ts.isClassDeclaration(statement) && statement.name?.text === "DispatcherLoop") ||
						(ts.isInterfaceDeclaration(statement) &&
							statement.name.text === "DispatcherLoopOptions")
					)) {
						report(
							"loop-exports",
							statement,
							"Only DispatcherLoop and its options belong in the loop module",
						);
					}
				}
			}
		}
	}
} finally {
	api.close();
}

for (const edge of edges) {
	const from = display(edge.from);
	const to = display(edge.to);
	if (from.startsWith("src/contracts/") && !to.startsWith("src/contracts/")) {
		report(
			"contracts-boundary",
			edge.node,
			`${from} -> ${to}: contracts may only depend on contracts`,
		);
	}
	if (
		from.startsWith("src/shared/") &&
		!to.startsWith("src/shared/") &&
		!to.startsWith("src/contracts/")
	) {
		report(
			"shared-boundary",
			edge.node,
			`${from} -> ${to}: shared may only depend on shared or contracts`,
		);
	}
	if (
		from.startsWith("src/web/") &&
		!to.startsWith("src/web/") &&
		!to.startsWith("src/contracts/") &&
		!to.startsWith("src/shared/")
	) {
		report(
			"web-boundary",
			edge.node,
			`${from} -> ${to}: web may only depend on web, contracts, or shared`,
		);
	}
	if (
		(from.startsWith("src/worker/") || from.startsWith("src/agents/runtime/")) &&
		(to.startsWith("src/server/") || to.startsWith("src/scheduler/"))
	) {
		report(
			"runtime-boundary",
			edge.node,
			`${from} -> ${to}: Worker and Agent runtime must not import Server or Scheduler, including types`,
		);
	}
	if (
		edge.to === loopFile &&
		(!(edge.from === cliFile || within(edge.from, cliRoot) || within(edge.from, testsRoot)) ||
			!edge.loopNames?.length ||
			edge.loopNames.some((name) => !loopExports.has(name)))
	) {
		report(
			"loop-import",
			edge.node,
			`${from} -> ${to}: only CLI and tests may import DispatcherLoop and its options by name`,
		);
	}
}

const graph = new Map<string, Edge[]>();
for (const edge of edges) {
	if (!edge.runtime || !within(edge.from, sourceRoot) || !within(edge.to, sourceRoot)) continue;
	const outgoing = graph.get(edge.from) ?? [];
	outgoing.push(edge);
	graph.set(edge.from, outgoing);
}

// Each DFS back edge reports a complete cycle, with the location of every import.
const visited = new Set<string>();
const active = new Map<string, number>();
const stack: Edge[] = [];
function walk(file: string): void {
	visited.add(file);
	active.set(file, stack.length);
	for (const edge of graph.get(file) ?? []) {
		const start = active.get(edge.to);
		if (start !== undefined) {
			const cycle = [...stack.slice(start), edge];
			report(
				"runtime-cycle",
				edge.node,
				[...cycle.map((item) => display(item.from)), display(edge.to)].join(" -> "),
			);
			for (const item of cycle) {
				const source = item.node.getSourceFile();
				const { line, character } = source.getLineAndCharacterOfPosition(item.node.getStart());
				console.error(
					`  ${display(item.from)}:${line + 1}:${character + 1} -> ${display(item.to)}`,
				);
			}
		} else if (!visited.has(edge.to)) {
			stack.push(edge);
			walk(edge.to);
			stack.pop();
		}
	}
	active.delete(file);
}
for (const file of graph.keys()) if (!visited.has(file)) walk(file);

// 浏览器安全：从 src/web 可达的模块不得 import Node 内置模块，否则只有打包或运行时
// 才会暴露。web 文件本身也在起点集合里，所以 web 直接 import 内置模块也会被抓到。
const reachable = new Set<string>();
const webStack = [...webFiles];
while (webStack.length > 0) {
	const current = webStack.pop()!;
	if (reachable.has(current)) continue;
	reachable.add(current);
	for (const edge of graph.get(current) ?? []) webStack.push(edge.to);
}
for (const entry of nodeImports) {
	if (!reachable.has(entry.file)) continue;
	report(
		"web-browser-safe",
		entry.node,
		`${display(entry.file)} imports ${entry.specifier}, but is reachable from src/web`,
	);
}

if (violations) {
	console.error(`Dependency check failed: ${violations} violation(s).`);
	process.exitCode = 1;
} else {
	console.log(`Dependency check passed: ${fileCount} files checked; src runtime graph is acyclic.`);
}
