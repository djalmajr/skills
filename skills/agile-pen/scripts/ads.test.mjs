import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main, normalizeDesign, parseDesignMarkdown } from "./ads.mjs";
import { buildInventory, buildSnapshot, run } from "./lib/catalog.mjs";
import { parseComponentKeys, registryUiImports, rendererComponentsConfig, rendererHash, rendererRequest, resolveRegistryStyle, resolveRendererCacheRoot } from "./lib/renderer.mjs";
import { installRegistryCommandHarness } from "./lib/registry-harness.mjs";
import { parseShadcnAddCommand } from "./lib/shadcn-command.mjs";
import { ingestCapture } from "./lib/ingest.mjs";
import { recordValidation } from "./lib/validation.mjs";
import { auditLayoutEvidence } from "./lib/layout-audit.mjs";
import { runParityAudit, verifyPrototypeParity } from "./lib/parity.mjs";
import { buildPrototypeEvidence, initializePrototype, reconcilePrototype, registerPrototypeComponent } from "./lib/prototype-reconcile.mjs";
import { resolveProjectPaths } from "./lib/project-paths.mjs";
import { PEN_CAPTURE_PACKAGE, PEN_CAPTURE_REGISTRY, PEN_CAPTURE_VERSION, normalizeGeneratedBatchLabels, parsePenCaptureArgs, penCaptureCacheRoot } from "./pen-capture.mjs";
import { blockCategory, officialPageBlocks } from "./validate-shadcn-blocks.mjs";

const starterPath = new URL("../assets/pencil/presets/nova/DESIGN.md", import.meta.url);

test("selects every official block exposed by the shadcn blocks pages", async () => {
  const snapshot = JSON.parse(await readFile(new URL("../assets/catalog/shadcn.snapshot.json", import.meta.url), "utf8"));
  const blocks = officialPageBlocks(snapshot);
  assert.equal(blocks.length, 27);
  assert.deepEqual(blocks.filter(block => blockCategory(block) === "dashboard"), ["dashboard-01"]);
  assert.deepEqual(blocks.filter(block => blockCategory(block) === "sidebar"), Array.from({length:16}, (_, index) => `sidebar-${String(index + 1).padStart(2, "0")}`));
  assert.deepEqual(blocks.filter(block => blockCategory(block) === "login"), Array.from({length:5}, (_, index) => `login-${String(index + 1).padStart(2, "0")}`));
  assert.deepEqual(blocks.filter(block => blockCategory(block) === "signup"), Array.from({length:5}, (_, index) => `signup-${String(index + 1).padStart(2, "0")}`));
  assert.equal(blocks.includes("chart-area-default"), false);
});

test("infers undeclared UI dependencies from official registry block imports", () => {
  const items = [{files:[
    {content:'import { Field } from "@/registry/new-york-v4/ui/field"'},
    {content:'import { Collapsible } from "@/registry/new-york-v4/ui/collapsible"'},
    {content:'import { FieldLabel } from "@/registry/new-york-v4/ui/field"'}
  ]}];
  assert.deepEqual(registryUiImports(items), ["collapsible", "field"]);
});

test("uses the official new-york-v4 style for registry examples", () => {
  const snapshots = [{source:"shadcn",items:[{name:"command-demo",type:"registry:example",addCommandArgument:"@shadcn/command-demo"}]}];
  assert.equal(resolveRegistryStyle({requestedItems:["command-demo"]}, snapshots), "new-york-v4");
  assert.equal(resolveRegistryStyle({requestedItems:["dashboard-01"]}, snapshots), undefined);
});

test("keeps the selected radix preset for Dice UI registry examples", () => {
  const snapshots = [{source:"dice-ui",items:[{name:"data-table-demo",type:"registry:example",addCommandArgument:"@diceui/data-table-demo"}]}];
  assert.equal(resolveRegistryStyle({requestedItems:["data-table-demo"]}, snapshots), undefined);
});

test("uses the current style-independent Dice UI registry endpoint", () => {
  const config = rendererComponentsConfig({style:"radix-nova",registries:{"@other":"https://example.test/{name}.json"}});
  assert.equal(config.registries["@diceui"], "https://diceui.com/r/{name}.json");
  assert.equal(config.registries["@other"], "https://example.test/{name}.json");
});

test("parses and normalizes the neutral DESIGN.md", async () => {
  const source = await readFile(starterPath, "utf8");
  const variables = normalizeDesign(parseDesignMarkdown(source));
  assert.equal(variables["--icon-library"].value, "lucide");
  assert.equal(variables["--background"].value, "#FFFFFF");
  assert.equal(variables["--sidebar"].value, "#FAFAFA");
});

test("rejects a missing semantic icon role", async () => {
  const source = (await readFile(starterPath, "utf8")).replace('    delete: "trash-2"\n', "");
  assert.throws(() => normalizeDesign(parseDesignMarkdown(source)), /pencil\.icons\.delete/);
});

test("builds deterministic registry snapshots and a fully assigned inventory", () => {
  const shadcn = buildSnapshot({
    source: "shadcn",
    registry: "@shadcn",
    cliVersion: "4.13.1",
    items: [{name: "button", type: "registry:ui", registry: "@shadcn", addCommandArgument: "@shadcn/button"}]
  });
  const dice = buildSnapshot({
    source: "dice-ui",
    registry: "@diceui",
    cliVersion: "4.13.1",
    items: [{name: "kanban", type: "registry:ui", registry: "@diceui", addCommandArgument: "@diceui/kanban"}]
  });
  const taxonomy = {
    schemaVersion: 1,
    source: {visual: ["shadcn", "dice-ui"], organization: "htm-ui"},
    categories: [
      {id: "general", label: "General", description: "Foundations"},
      {id: "data-display", label: "Data Display", description: "Structured content"}
    ],
    assignments: {general: ["shadcn:button"], "data-display": ["dice-ui:kanban"]}
  };
  const inventory = buildInventory([shadcn, dice], taxonomy);
  assert.equal(inventory.categories[0].components[0].key, "shadcn:button");
  assert.equal(inventory.categories[1].components[0].key, "dice-ui:kanban");
  assert.equal(buildSnapshot({source: "shadcn", registry: "@shadcn", cliVersion: "4.13.1", items: shadcn.items}).checksum, shadcn.checksum);
});

test("rejects official components missing from the taxonomy", () => {
  const snapshot = buildSnapshot({
    source: "shadcn",
    registry: "@shadcn",
    cliVersion: "4.13.1",
    items: [{name: "button", type: "registry:ui", registry: "@shadcn", addCommandArgument: "@shadcn/button"}]
  });
  assert.throws(() => buildInventory([snapshot], {
    source: {}, categories: [{id: "general"}], assignments: {general: []}
  }), /unassigned official components: shadcn:button/);
});

test("normalizes component keys and includes preset resolution in the renderer hash", () => {
  assert.deepEqual(parseComponentKeys("dice:kanban, shadcn:sidebar,dice-ui:kanban"), ["dice-ui:kanban", "shadcn:sidebar"]);
  const request = rendererRequest({
    cliVersion: "4.13.1",
    template: "vite",
    base: "base",
    preset: "nova",
    components: ["shadcn:button"],
    catalogChecksums: {shadcn: "abc"},
    environment: {locale: "en-US"}
  });
  assert.equal(request.registryHarnessVersion, "1.2.1");
  assert.notEqual(rendererHash(request, {code: "one"}), rendererHash(request, {code: "two"}));
});

test("keeps the renderer cache inside the target project by default", async () => {
  const project = await mkdtemp(join(tmpdir(), "ads-renderer-cache-"));
  try {
    assert.equal(resolveRendererCacheRoot({project}), join(project, ".cache/agile-pen/renderer"));
    assert.equal(resolveRendererCacheRoot({project, cache:join(project, "custom-cache")}), join(project, "custom-cache"));
  } finally {
    await rm(project, {recursive:true, force:true});
  }
});

test("pins pen-capture from GitHub Packages in the target project cache", () => {
  const parsed = parsePenCaptureArgs(["--project", "fixture", "convert", "capture.json", "tree.json"], "/tmp/work");
  assert.equal(parsed.project, "/tmp/work/fixture");
  assert.deepEqual(parsed.forwarded, ["convert", "capture.json", "tree.json"]);
  assert.equal(PEN_CAPTURE_PACKAGE, "@djalmajr/pen-capture");
  assert.equal(PEN_CAPTURE_VERSION, "0.1.6");
  assert.equal(PEN_CAPTURE_REGISTRY, "https://npm.pkg.github.com");
  assert.equal(penCaptureCacheRoot(parsed.project), "/tmp/work/fixture/.cache/agile-pen/pen-capture/0.1.6");
});

test("removes duplicated Pen.dev node IDs from generated batch labels", () => {
  const source = "Update(id,{name:data.name.replace(/ \\(#?[-A-Za-z0-9]+\\)$/,'')+' ('+id+')'});";
  assert.equal(
    normalizeGeneratedBatchLabels(source),
    "Update(id,{name:data.name.replace(/ \\(#?[-A-Za-z0-9]+\\)$/,'')});"
  );
});

test("captures registry-sized stdout without the Bun pipe limit", async () => {
  const result = await run("bun", ["-e", 'process.stdout.write("x".repeat(90000))'], {captureLargeStdout:true});
  assert.equal(result.stdout.length, 90000);
});

test("normalizes supported shadcn add runners including yarn dlx", () => {
  const commands = [
    "npx shadcn@latest add login-03",
    "pnpm dlx shadcn@latest add login-03",
    "yarn dlx shadcn@latest add login-03",
    "bun x shadcn@latest add login-03",
    "bunx --bun shadcn@latest add login-03",
    "npm exec -- shadcn@latest add login-03"
  ].map(parseShadcnAddCommand);
  assert.deepEqual([...new Set(commands.map(command => command.normalized))], ["shadcn@latest add login-03"]);
  assert.deepEqual(commands.map(command => command.runner), ["npx", "pnpm dlx", "yarn dlx", "bun x", "bunx --bun", "npm exec"]);
  assert.deepEqual(parseShadcnAddCommand('bun x shadcn@latest add "@diceui/data-table-filter-list"').requestedItems, ["@diceui/data-table-filter-list"]);
});

test("rejects unsafe or non-rendering shadcn commands", () => {
  assert.throws(() => parseShadcnAddCommand("yarn dlx shadcn@latest search @shadcn"), /only shadcn add/);
  assert.throws(() => parseShadcnAddCommand("npx shadcn@latest add login-03 --cwd ../outside"), /controlled by the deterministic renderer/);
  assert.throws(() => parseShadcnAddCommand("npx shadcn@latest add login-03 && touch owned"), /control operators/);
  assert.throws(() => parseShadcnAddCommand("npx shadcn@latest add $(whoami)"), /shell evaluation/);
});

test("builds a deterministic capture route from an installed registry block", async () => {
  const project = await mkdtemp(join(tmpdir(), "ads-registry-harness-"));
  try {
    await mkdir(join(project, "src/components"), {recursive:true});
    await mkdir(join(project, "src/components/ui"), {recursive:true});
    await writeFile(join(project, "src/App.tsx"), "export default function App(){return null}\n");
    await writeFile(join(project, "src/main.tsx"), "export {}\n");
    await writeFile(join(project, "tsconfig.app.json"), '{"compilerOptions":{"noUnusedLocals":true,"noUnusedParameters":true}}\n');
    await writeFile(join(project, "src/components/login-form.tsx"), "export function LoginForm(){return <form>Login</form>}\n");
    await writeFile(join(project, "src/components/ui/tooltip.tsx"), "export function TooltipProvider({children}){return children}\n");
    const command = parseShadcnAddCommand("yarn dlx shadcn@latest add login-03");
    const routes = await installRegistryCommandHarness(project, command, [{name:"login-03",type:"registry:block",files:[
      {path:"registry/base-nova/blocks/login-03/page.tsx",type:"registry:page",content:`import data from "./data.json"\nimport { LoginForm } from "@/registry/base-nova/blocks/login-03/components/login-form"\nimport { IconPlaceholder } from "@/app/icon-placeholder"\nexport default function LoginPage(){return <main className="grid min-h-svh place-items-center"><IconPlaceholder lucide="GalleryVerticalEndIcon" className="size-4" /><LoginForm data={data} /></main>}\n`},
      {path:"registry/base-nova/blocks/login-03/data.json",type:"registry:file",content:'[{"id":1}]\n'}
    ]}]);
    assert.equal(routes[0].route, "/capture/registry/login-03");
    assert.equal(routes[0].selector, "[data-capture='registry:login-03']");
    assert.equal(routes[0].provenance.entry, "src/registry-entry.tsx");
    assert.match(await readFile(join(project, "src/App.tsx"), "utf8"), /import RegistryEntry/);
    assert.match(await readFile(join(project, "src/App.tsx"), "utf8"), /<TooltipProvider><RegistryEntry \/><\/TooltipProvider>/);
    const entry = await readFile(join(project, "src/registry-entry.tsx"), "utf8");
    assert.match(entry, /@\/components\/login-form/);
    assert.match(entry, /GalleryVerticalEndIcon/);
    assert.doesNotMatch(entry, /IconPlaceholder/);
    assert.equal(await readFile(join(project, "src/data.json"), "utf8"), '[{"id":1}]\n');
    assert.match(await readFile(join(project, "tsconfig.app.json"), "utf8"), /"noUnusedLocals": false/);
  } finally {
    await rm(project, {recursive:true, force:true});
  }
});

test("ingests neutral capture artifacts without reading or writing a .pen file", async () => {
  const project = await mkdtemp(join(tmpdir(), "ads-ingest-"));
  try {
    const capturePath = join(project, "button.capture.json");
    const treePath = join(project, "button.tree.json");
    const batchPath = join(project, "button.batch.js");
    await writeFile(capturePath, `${JSON.stringify({
      format: "pen-capture-ir", version: 1, label: "Button", rootPath: "0",
      source: {url: "http://fixture.test", selector: "[data-capture='button']"},
      environment: {locale: "en-US", timezone: "UTC"}, nodes: []
    })}\n`);
    await writeFile(treePath, `${JSON.stringify({root: {type: "frame", name: "Captured · Button"}, stats: {nodes: 1}})}\n`);
    await writeFile(batchPath, "const pos=FindEmptySpace({width:1,height:1}); const id=Insert(document,{}); Update(id,{name:'Example ('+id+')'});\n");
    await writeFile(join(project, "renderer.lock.json"), `${JSON.stringify({rendererHash:"abc",cliVersion:"4.13.1",base:"base",preset:{requested:"nova",resolved:{code:"b2fA"}}})}\n`);
    const result = await ingestCapture({
      capture: capturePath, tree: treePath, batch: batchPath,
      source: "shadcn", component: "button", example: "default", project,
      "renderer-lock": join(project, "renderer.lock.json")
    });
    assert.equal(result.entry.writer, "pencil-mcp-only");
    assert.equal(result.entry.namingConvention, "Semantic label");
    assert.equal(result.entry.registry, "@shadcn");
    const lock = JSON.parse(await readFile(result.lock, "utf8"));
    assert.equal(lock.components.length, 1);
    await writeFile(capturePath, `${JSON.stringify({
      format: "pencil-capture-ir", version: 1, label: "Button legacy", rootPath: "0",
      source: {url: "http://fixture.test", selector: "[data-capture='button-legacy']"},
      environment: {locale: "en-US", timezone: "UTC"}, nodes: []
    })}\n`);
    const legacy = await ingestCapture({
      capture: capturePath, tree: treePath, batch: batchPath,
      source: "shadcn", component: "button", example: "legacy", project,
      "renderer-lock": join(project, "renderer.lock.json")
    });
    assert.equal(legacy.entry.writer, "pencil-mcp-only");
    assert.equal(JSON.parse(await readFile(legacy.lock, "utf8")).components.length, 2);
    const community = await ingestCapture({
      capture: capturePath, tree: treePath, batch: batchPath,
      source: "community", registry: "@acme-ui", component: "button", example: "default", project,
      "renderer-lock": join(project, "renderer.lock.json")
    });
    assert.equal(community.entry.registry, "@acme-ui");
    await assert.rejects(() => ingestCapture({
      capture: capturePath, tree: treePath, batch: batchPath,
      source: "community", component: "button", example: "missing-registry", project,
      "renderer-lock": join(project, "renderer.lock.json")
    }), /require --registry/);
    await assert.rejects(() => ingestCapture({
      capture: join(project, "forbidden.pen"), tree: treePath, batch: batchPath,
      source: "shadcn", component: "button", example: "default", project,
      "renderer-lock": join(project, "renderer.lock.json")
    }), /must not be a \.pen file/);
  } finally {
    await rm(project, {recursive: true, force: true});
  }
});

test("records semantic, layout and visual evidence without accessing a .pen file", async () => {
  const project = await mkdtemp(join(tmpdir(), "ads-validation-"));
  try {
    const paths = resolveProjectPaths(project);
    await mkdir(paths.contracts, {recursive:true});
    await mkdir(paths.evidence, {recursive:true});
    await writeFile(join(paths.contracts, "renderer.lock.json"), `${JSON.stringify({rendererHash:"renderer-1"})}\n`);
    const report = join(paths.evidence, "report.json");
    await writeFile(report, `${JSON.stringify({normalizedRmse:0.08,gates:{passed:true,sameSize:true,maxRmse:0.15}})}\n`);
    const layoutReport = join(paths.evidence, "layout-audit.report.json");
    await writeFile(layoutReport, `${JSON.stringify({passed:true,overlaps:[],namingViolations:[],geometryViolations:[],coherenceViolations:[]})}\n`);
    const parityReport = join(paths.evidence, "parity-audit.report.json");
    await writeFile(parityReport, `${JSON.stringify({passed:true,coverage:{screens:{percent:100},components:{percent:100},instances:{percent:100},manualComponents:0}})}\n`);
    const result = await recordValidation({project, screen:"board", refs:"shadcn:sidebar:component-1:instance-1", reports:`sidebar=${report}`, "layout-report":layoutReport, "parity-report":parityReport});
    assert.equal(result.manifest.semantic.refs[0].componentNodeId, "component-1");
    assert.equal(result.manifest.layout.passed, true);
    assert.equal(result.manifest.layout.rootOverlaps, 0);
    assert.equal(result.manifest.layout.coherenceViolations, 0);
    assert.equal(result.manifest.parity.coverage.instances.percent, 100);
    assert.equal(result.manifest.visual[0].normalizedRmse, 0.08);
  } finally {
    await rm(project, {recursive: true, force: true});
  }
});

test("requires and verifies 100% prototype-to-code catalog parity", async () => {
  // Mutation captured: a manual component, uncataloged ref, or changed code counterpart makes parity fail closed.
  const project = await mkdtemp(join(tmpdir(), "ads-parity-"));
  try {
    const paths = resolveProjectPaths(project);
    const codePath = join(project, "app/src/components/ui/button.tsx");
    const codeSource = "export function Button(){ return null }\n";
    const themePath = join(project, "design/theme-bindings/button.json");
    const themeSource = `${JSON.stringify({schemaVersion:1,source:"DESIGN.md",descendants:{"button-surface":{fill:"$--primary"}}})}\n`;
    await mkdir(join(project, "app/src/components/ui"), {recursive:true});
    await mkdir(join(project, "design/system"), {recursive:true});
    await mkdir(join(project, "design/theme-bindings"), {recursive:true});
    await mkdir(paths.contracts, {recursive:true});
    await mkdir(paths.evidence, {recursive:true});
    await writeFile(codePath, codeSource);
    await writeFile(themePath, themeSource);
    await writeFile(join(project, "design/system/pencil-variables.json"), `${JSON.stringify({schemaVersion:1,source:"DESIGN.md",variables:{"--primary":{type:"color",value:"#000000"}}})}\n`);
    await writeFile(join(project, "design-system.lock.json"), `${JSON.stringify({prototype:{path:"product.pen"}})}\n`);
    await writeFile(join(paths.contracts, "components.manifest.json"), `${JSON.stringify({schemaVersion:1,components:[{id:"shadcn-button-default",source:"shadcn"}]})}\n`);
    await writeFile(join(paths.contracts, "capture.lock.json"), `${JSON.stringify({schemaVersion:1,components:[{id:"shadcn-button-default"}]})}\n`);
    await writeFile(join(paths.contracts, "prototype.catalog.json"), `${JSON.stringify({
      schemaVersion:2,
      prototype:"product.pen",
      components:[{
        id:"button",
        source:"shadcn",
        registry:"@shadcn/button",
        captureId:"shadcn-button-default",
        componentNodeId:"component-button",
        theme:{source:"DESIGN.md",path:"design/theme-bindings/button.json",checksum:createHash("sha256").update(themeSource).digest("hex"),descendants:{"button-surface":{fill:"$--primary"}}},
        code:[{path:"app/src/components/ui/button.tsx",checksum:createHash("sha256").update(codeSource).digest("hex")}]
      }],
      screens:[{nodeId:"screen-projects",name:"Projects",instances:[{nodeId:"instance-button",componentId:"button"}]}]
    })}\n`);
    const evidence = {
      schemaVersion:2,
      source:"Pencil MCP batch_get",
      prototype:"product.pen",
      screens:[{nodeId:"screen-projects",name:"Projects"}],
      reusable:[{nodeId:"component-button",name:"Captured · shadcn · button · default"}],
      refs:[{nodeId:"instance-button",refNodeId:"component-button",screenNodeId:"screen-projects",descendants:{"button-surface":{fill:"$--primary"}}}],
      inspection:{
        complete:true,
        nodeCount:3,
        componentCandidates:[
          {nodeId:"component-button",name:"Captured · shadcn · button · default",type:"frame",reusable:true},
          {nodeId:"instance-button",name:"Primary action",type:"ref",refNodeId:"component-button",screenNodeId:"screen-projects"}
        ]
      },
      manualComponents:[]
    };
    await writeFile(join(paths.evidence, "prototype-evidence.json"), `${JSON.stringify(evidence)}\n`);
    const report = await verifyPrototypeParity({project});
    assert.equal(report.passed, true);
    assert.equal(report.coverage.screens.percent, 100);
    assert.equal(report.coverage.components.percent, 100);
    assert.equal(report.coverage.instances.percent, 100);
    const persisted = await runParityAudit({project});
    assert.equal(JSON.parse(await readFile(persisted.output, "utf8")).passed, true);

    await writeFile(join(paths.evidence, "prototype-evidence.json"), `${JSON.stringify({...evidence,manualComponents:[{nodeId:"manual-button"}]})}\n`);
    await assert.rejects(() => verifyPrototypeParity({project}), /manual Pen\.dev components are forbidden/);
    await writeFile(join(paths.evidence, "prototype-evidence.json"), `${JSON.stringify({
      ...evidence,
      inspection:{...evidence.inspection,componentCandidates:[
        ...evidence.inspection.componentCandidates,
        {nodeId:"fake-mapped-button",name:"Mapped · shadcn · Button",type:"frame"}
      ]}
    })}\n`);
    await assert.rejects(() => verifyPrototypeParity({project}), /labels are not capture evidence/);
    await writeFile(join(paths.evidence, "prototype-evidence.json"), `${JSON.stringify({
      ...evidence,
      inspection:{...evidence.inspection,componentCandidates:[
        ...evidence.inspection.componentCandidates,
        {nodeId:"manual-input",name:"Search input",type:"frame"}
      ]}
    })}\n`);
    await assert.rejects(() => verifyPrototypeParity({project}), /manual Pen\.dev component candidate is forbidden/);
    await writeFile(join(paths.evidence, "prototype-evidence.json"), `${JSON.stringify({...evidence,inspection:{...evidence.inspection,complete:false}})}\n`);
    await assert.rejects(() => verifyPrototypeParity({project}), /inspection\.complete must be true/);
    await writeFile(join(paths.evidence, "prototype-evidence.json"), `${JSON.stringify({
      ...evidence,
      refs:[...evidence.refs,{nodeId:"instance-uncataloged",refNodeId:"component-button",screenNodeId:"screen-projects"}],
      inspection:{...evidence.inspection,componentCandidates:[
        ...evidence.inspection.componentCandidates,
        {nodeId:"instance-uncataloged",name:"Secondary action",type:"ref",refNodeId:"component-button",screenNodeId:"screen-projects"}
      ]}
    })}\n`);
    await assert.rejects(() => verifyPrototypeParity({project}), /uncataloged Pen\.dev ref instance/);
    await writeFile(join(paths.evidence, "prototype-evidence.json"), `${JSON.stringify(evidence)}\n`);
    await writeFile(codePath, "export function Button(){ return 'changed' }\n");
    await assert.rejects(() => verifyPrototypeParity({project}), /code counterpart changed/);
  } finally {
    await rm(project, {recursive:true,force:true});
  }
});

test("initializes, registers and reconciles a complete Pencil MCP prototype inventory", async () => {
  const project = await mkdtemp(join(tmpdir(), "ads-prototype-reconcile-"));
  try {
    const paths = resolveProjectPaths(project);
    const codePath = join(project, "app/src/components/ui/kanban.tsx");
    await mkdir(join(project, "app/src/components/ui"), {recursive:true});
    await mkdir(join(project, "design/system"), {recursive:true});
    await mkdir(join(project, "design/theme-bindings"), {recursive:true});
    await mkdir(paths.contracts, {recursive:true});
    await mkdir(paths.evidence, {recursive:true});
    await writeFile(codePath, "export function Kanban(){ return null }\n");
    await writeFile(join(project, "design/system/pencil-variables.json"), `${JSON.stringify({schemaVersion:1,source:"DESIGN.md",variables:{"--sidebar":{type:"color",value:"#FAFAFA"}}})}\n`);
    await writeFile(join(project, "design/theme-bindings/kanban.json"), `${JSON.stringify({schemaVersion:1,source:"DESIGN.md",descendants:{"column-surface":{fill:"$--sidebar"}}})}\n`);
    await writeFile(join(project, "design-system.lock.json"), `${JSON.stringify({schemaVersion:2,writer:"pencil-mcp-only"})}\n`);
    await writeFile(join(paths.contracts, "components.manifest.json"), `${JSON.stringify({schemaVersion:1,components:[{
      id:"dice-ui-kanban-board",source:"dice-ui",registry:"@diceui",component:"kanban"
    }]})}\n`);
    await writeFile(join(paths.contracts, "capture.lock.json"), `${JSON.stringify({schemaVersion:1,components:[{id:"dice-ui-kanban-board"}]})}\n`);
    await writeFile(join(paths.contracts, "prototype.catalog.json"), `${JSON.stringify({schemaVersion:1,prototype:"product.pen",components:[],screens:[]})}\n`);
    await initializePrototype({project,path:"product.pen"});
    assert.equal(JSON.parse(await readFile(join(paths.contracts, "prototype.catalog.json"), "utf8")).schemaVersion, 2);
    await writeFile(join(paths.contracts, "generated-kanban.tsx"), "export function GeneratedKanban(){ return null }\n");
    await assert.rejects(() => registerPrototypeComponent({
      project,
      capture:"dice-ui-kanban-board",
      "component-node":"component-kanban",
      code:"design/contracts/generated-kanban.tsx",
      "theme-bindings":"design/theme-bindings/kanban.json"
    }), /code counterpart must be project source/);
    await writeFile(join(project, "design/theme-bindings/kanban.json"), `${JSON.stringify({schemaVersion:1,source:"DESIGN.md",descendants:{"column-surface":{fill:"$--missing"}}})}\n`);
    await assert.rejects(() => registerPrototypeComponent({
      project,
      capture:"dice-ui-kanban-board",
      "component-node":"component-kanban",
      code:"app/src/components/ui/kanban.tsx",
      "theme-bindings":"design/theme-bindings/kanban.json"
    }), /token absent from DESIGN\.md/);
    await writeFile(join(project, "design/theme-bindings/kanban.json"), `${JSON.stringify({schemaVersion:1,source:"DESIGN.md",descendants:{"column-surface":{fill:"$--sidebar"}}})}\n`);
    const registration = await registerPrototypeComponent({
      project,
      capture:"dice-ui-kanban-board",
      "component-node":"component-kanban",
      code:"app/src/components/ui/kanban.tsx",
      "theme-bindings":"design/theme-bindings/kanban.json"
    });
    assert.equal(registration.entry.registry, "@diceui/kanban");
    assert.equal(registration.entry.componentNodeId, "component-kanban");
    assert.equal(registration.entry.implementation.mode, "installed");
    assert.match(registration.entry.code[0].checksum, /^[a-f0-9]{64}$/);
    await assert.rejects(() => registerPrototypeComponent({
      project,
      capture:"dice-ui-kanban-board",
      "component-node":"component-kanban",
      "theme-bindings":"design/theme-bindings/kanban.json"
    }), /either --code, one --demo-url, or one --reference-image/);
    const referencedRegistration = await registerPrototypeComponent({
      project,
      capture:"dice-ui-kanban-board",
      "component-node":"component-kanban",
      "demo-url":"https://diceui.com/docs/components/radix/kanban",
      "registry-url":"https://diceui.com/r/kanban.json",
      "install-command":"bunx --bun shadcn@latest add @diceui/kanban",
      "theme-bindings":"design/theme-bindings/kanban.json"
    });
    assert.equal(referencedRegistration.entry.implementation.mode, "catalog-reference");
    assert.equal(referencedRegistration.entry.implementation.demoUrl, "https://diceui.com/docs/components/radix/kanban");
    assert.equal(referencedRegistration.entry.implementation.installCommand, "bunx --bun shadcn@latest add @diceui/kanban");
    assert.equal(referencedRegistration.entry.code, undefined);
    await mkdir(join(project, "design/references"), {recursive:true});
    await writeFile(join(project, "design/references/kanban.png"), "image evidence");
    const imageRegistration = await registerPrototypeComponent({
      project,
      capture:"dice-ui-kanban-board",
      "component-node":"component-kanban",
      "reference-image":"design/references/kanban.png",
      "repository-url":"https://github.com/example/kanban",
      "component-reference":"Kanban board",
      "theme-bindings":"design/theme-bindings/kanban.json"
    });
    assert.equal(imageRegistration.entry.implementation.evidence.kind, "user-image");
    assert.equal(imageRegistration.entry.implementation.evidence.association, "user-attested");
    assert.match(imageRegistration.entry.implementation.evidence.checksum, /^[a-f0-9]{64}$/);
    assert.equal(imageRegistration.entry.implementation.installCommand, undefined);

    const inventoryPath = join(project, "prototype-inventory.json");
    const inventory = {
      schemaVersion:2,
      source:"Pencil MCP batch_get",
      prototype:"product.pen",
      complete:true,
      topLevelNodeCount:2,
      nodeCount:4,
      screens:[{nodeId:"screen-board",name:"Project board"}],
      roots:[
        {id:"component-kanban",name:"Captured · dice-ui · kanban · board",type:"frame",reusable:true,children:[
          {id:"column-surface",name:"Column surface",type:"frame",fill:"$--sidebar",children:[]}
        ]},
        {id:"screen-board",name:"Project board",type:"frame",children:[
          {id:"instance-board",name:"Tasks board",type:"ref",ref:"component-kanban",descendants:{}}
        ]}
      ]
    };
    await writeFile(inventoryPath, `${JSON.stringify(inventory)}\n`);
    const reconciled = await reconcilePrototype({project,input:inventoryPath});
    assert.equal(reconciled.report.passed, true);
    const catalog = JSON.parse(await readFile(join(paths.contracts, "prototype.catalog.json"), "utf8"));
    assert.deepEqual(catalog.screens[0].instances, [{nodeId:"instance-board",componentId:"dice-ui-kanban-board"}]);
    const evidence = JSON.parse(await readFile(join(paths.evidence, "prototype-evidence.json"), "utf8"));
    assert.equal(evidence.inspection.nodeCount, 4);
    assert.equal(evidence.reusable[0].descendants["column-surface"].fill, "$--sidebar");
    assert.equal(evidence.manualComponents.length, 0);

    const partialInventory = {
      ...inventory,
      nodeCount:6,
      roots:[
        inventory.roots[0],
        {id:"component-unregistered",name:"Captured · community · timeline",type:"frame",reusable:true,children:[]},
        {...inventory.roots[1],children:[
          ...inventory.roots[1].children,
          {id:"instance-unregistered",name:"Timeline",type:"ref",ref:"component-unregistered",descendants:{}}
        ]}
      ],
      topLevelNodeCount:3
    };
    await writeFile(inventoryPath, `${JSON.stringify(partialInventory)}\n`);
    const partial = await reconcilePrototype({project,input:inventoryPath});
    assert.equal(partial.report.advisory, true);
    assert.match(partial.warnings[0].message, /unregistered reusable root/);
    assert.deepEqual(
      JSON.parse(await readFile(join(paths.contracts, "prototype.catalog.json"), "utf8")).screens[0].instances,
      [{nodeId:"instance-board",componentId:"dice-ui-kanban-board"}]
    );
    await assert.rejects(() => reconcilePrototype({project,input:inventoryPath,strict:true}), /unregistered reusable root/);

    await writeFile(inventoryPath, `${JSON.stringify({...inventory,roots:[
      inventory.roots[0],
      {...inventory.roots[1],children:[{id:"instance-board",name:"Tasks board",type:"ref",ref:"component-kanban",descendants:{"column-surface":{fill:"$--background"}}}]}
    ]})}\n`);
    const themeWarning = await reconcilePrototype({project,input:inventoryPath});
    assert.equal(themeWarning.report.passed, false);
    assert.match(themeWarning.warnings[0].message, /theme binding mismatch/);
    await assert.rejects(() => reconcilePrototype({project,input:inventoryPath,strict:true}), /theme binding mismatch/);
    await writeFile(inventoryPath, `${JSON.stringify(inventory)}\n`);

    await writeFile(inventoryPath, `${JSON.stringify({...inventory,nodeCount:5,roots:[
      ...inventory.roots,
      {id:"manual-button",name:"Pending capture · shadcn · Button",type:"frame",children:[]}
    ],topLevelNodeCount:3})}\n`);
    const manualWarning = await reconcilePrototype({project,input:inventoryPath});
    assert.equal(manualWarning.report.advisory, true);
    assert.match(manualWarning.warnings[0].message, /manual Pen\.dev components are forbidden/);
    await assert.rejects(() => reconcilePrototype({project,input:inventoryPath,strict:true}), /manual Pen\.dev components are forbidden/);
    await writeFile(inventoryPath, `${JSON.stringify({...inventory,nodeCount:2,roots:[
      {id:"screen-board",name:"Project board",type:"frame",children:"..."}
    ],topLevelNodeCount:1})}\n`);
    await assert.rejects(() => buildPrototypeEvidence({project,input:inventoryPath}), /prototype inventory is truncated/);
  } finally {
    await rm(project, {recursive:true,force:true});
  }
});

test("ads verify reports missing parity artifacts for a registered prototype", async () => {
  // Mutation captured: registering a prototype without its catalog turns a previously valid ADS project red.
  const project = await mkdtemp(join(tmpdir(), "ads-parity-required-"));
  try {
    await main(["install", "nova", "--project", project]);
    const lockPath = join(project, "design-system.lock.json");
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    lock.prototype = {path:"product.pen"};
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    await assert.rejects(() => main(["verify", "--project", project]), /prototype catalog is missing/);
  } finally {
    await rm(project, {recursive:true,force:true});
  }
});

test("rejects top-level overlap and role naming violations from Pencil MCP evidence", () => {
  const base = {schemaVersion:1,source:"Pencil MCP batch_get",nodes:[
    {id:"screen-a",role:"screen",name:"A",x:0,y:0,width:100,height:100},
    {id:"note-a",role:"note",name:"Wrong",x:50,y:50,width:100,height:100}
  ]};
  const failed = auditLayoutEvidence(base);
  assert.equal(failed.passed, false);
  assert.equal(failed.overlaps.length, 1);
  assert.deepEqual(failed.namingViolations, ["note-a"]);
  const alignedNodes = [base.nodes[0],{...base.nodes[1],name:"Note · A",x:0,y:160}];
  const widthFill = {id:"screen-a-content-width",type:"fills-axis",scopeId:"screen-a",targetId:"screen-a/main",axis:"width",containerSize:100,startInset:0,endInset:0,size:100,tolerance:0};
  const passed = auditLayoutEvidence({...base,nodes:alignedNodes,coherenceChecks:[{id:"shell",type:"equal",values:[720,720],tolerance:0},widthFill]});
  assert.equal(passed.passed, true);
  const duplicatedId = auditLayoutEvidence({...base,nodes:[{...alignedNodes[0],name:"A (screen-a)"},alignedNodes[1]]});
  assert.deepEqual(duplicatedId.namingViolations,["screen-a"]);
  const incoherent = auditLayoutEvidence({...base,nodes:alignedNodes,coherenceChecks:[{id:"shell",type:"equal",values:[720,680],tolerance:0},widthFill]});
  assert.deepEqual(incoherent.coherenceViolations,["shell"]);
  const missingWidthEvidence = auditLayoutEvidence({...base,nodes:alignedNodes,coherenceChecks:[{id:"shell",type:"equal",values:[720,720],tolerance:0}]});
  assert.deepEqual(missingWidthEvidence.coherenceViolations,["missing-width-fill:screen-a"]);
  const deadSpace = auditLayoutEvidence({...base,nodes:alignedNodes,coherenceChecks:[{...widthFill,size:72}]});
  assert.deepEqual(deadSpace.coherenceViolations,["screen-a-content-width","missing-width-fill:screen-a"]);
});

test("lists component slices and filters their examples", async () => {
  const output = [];
  const original = console.log;
  console.log = (...values) => output.push(values.join(" "));
  try {
    await main(["slices", "--category", "data-entry", "--source", "shadcn"]);
    await main(["examples", "--component", "form", "--facet", "validation"]);
  } finally {
    console.log = original;
  }
  assert.equal(output.length, 17);
  assert.match(output[0], /data-entry\tcalendar\tCalendar\tshadcn\tcaptured-faithful/);
  assert.match(output[5], /data-entry\tform\tForm\tshadcn\tpilot/);
  assert.match(output[15], /data-entry\ttoggle\tToggle\tshadcn\tcaptured-faithful/);
  assert.match(output[16], /data-entry\tform\tvalidation\tExample\/Data Entry\/Form\/Validation\tshadcn\tpilot/);
});

test("installs and verifies design variables without touching Pencil documents", async () => {
  const project = await mkdtemp(join(tmpdir(), "ads-test-"));
  try {
    const custom = (await readFile(starterPath, "utf8")).replace("#27272A", "#123456");
    await writeFile(join(project, "DESIGN.md"), custom);
    await main(["install", "nova", "--project", project]);
    await main(["install", "nova", "--project", project]);
    await main(["verify", "--project", project]);
    assert.equal(await readFile(join(project, "DESIGN.md"), "utf8"), custom);
    const lock = JSON.parse(await readFile(join(project, "design-system.lock.json"), "utf8"));
    assert.equal(lock.preset.id, "nova");
    assert.equal(lock.configured, true);
    assert.equal(lock.writer, "pencil-mcp-only");
    await assert.rejects(() => main(["configure", "--project", project, "--pen", "project.pen"]), /only Pencil MCP/);
  } finally {
    await rm(project, {recursive: true, force: true});
  }
});
