const controlTokens = new Set([";", "&&", "||", "|", ">", ">>", "<", "<<", "&"]);
const forbiddenAddOptions = new Set(["--cwd", "-c", "--path", "--dry-run", "--diff", "--view", "--help"]);

export function tokenizeCommand(value) {
  const source = String(value ?? "").trim();
  if (!source) throw new Error("--shadcn-command must not be empty");
  if (source.includes("`") || source.includes("$(")) throw new Error("shell evaluation is not allowed in --shadcn-command");
  const tokens = [];
  let token = "";
  let quote = null;
  let escaped = false;
  const push = () => {
    if (token) tokens.push(token);
    token = "";
  };
  for (const character of source) {
    if (escaped) {
      token += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else token += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      push();
      continue;
    }
    token += character;
  }
  if (escaped || quote) throw new Error("unterminated escape or quote in --shadcn-command");
  push();
  if (tokens.some(candidate => controlTokens.has(candidate))) throw new Error("shell control operators are not allowed in --shadcn-command");
  return tokens;
}

function parseRunner(tokens) {
  const [runner, second, third] = tokens;
  if (runner === "npx") return {offset: 1, runner: "npx"};
  if (runner === "pnpm" && second === "dlx") return {offset: 2, runner: "pnpm dlx"};
  if (runner === "yarn" && second === "dlx") return {offset: 2, runner: "yarn dlx"};
  if (runner === "bun" && second === "x") return {offset: 2, runner: "bun x"};
  if (runner === "bunx" && second === "--bun") return {offset: 2, runner: "bunx --bun"};
  if (runner === "bunx") return {offset: 1, runner: "bunx"};
  if (runner === "npm" && second === "exec") return {offset: third === "--" ? 3 : 2, runner: "npm exec"};
  throw new Error(`unsupported shadcn package runner: ${runner ?? ""}`);
}

function parsePackage(value) {
  const match = String(value ?? "").match(/^shadcn(?:@(.+))?$/);
  if (!match) throw new Error(`expected shadcn package, received: ${value ?? ""}`);
  return {package: "shadcn", requestedCliVersion: match[1] ?? null};
}

function assertSafeAddArguments(args) {
  if (!args.length) throw new Error("shadcn add requires at least one registry item or --all");
  for (const argument of args) {
    const option = argument.split("=", 1)[0];
    if (forbiddenAddOptions.has(option)) throw new Error(`${option} is controlled by the deterministic renderer`);
    if (controlTokens.has(argument)) throw new Error("shell control operators are not allowed in --shadcn-command");
  }
  if (!args.some(argument => argument === "--all" || !argument.startsWith("-"))) {
    throw new Error("shadcn add requires at least one registry item or --all");
  }
}

export function parseShadcnAddCommand(value) {
  const tokens = tokenizeCommand(value);
  const runner = parseRunner(tokens);
  const packageDefinition = parsePackage(tokens[runner.offset]);
  const command = tokens[runner.offset + 1];
  if (command !== "add") throw new Error(`only shadcn add commands can materialize UI, received: ${command ?? ""}`);
  const args = tokens.slice(runner.offset + 2);
  assertSafeAddArguments(args);
  const requestedItems = args.filter(argument => !argument.startsWith("-"));
  const cli = packageDefinition.requestedCliVersion ? `shadcn@${packageDefinition.requestedCliVersion}` : "shadcn";
  return {
    schemaVersion: 1,
    runner: runner.runner,
    package: packageDefinition.package,
    requestedCliVersion: packageDefinition.requestedCliVersion,
    command,
    args,
    requestedItems,
    normalized: [cli, command, ...args].join(" ")
  };
}
