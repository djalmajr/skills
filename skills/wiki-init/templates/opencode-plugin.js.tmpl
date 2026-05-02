import { existsSync } from "node:fs";
import { join } from "node:path";

const mutationTools = new Set([
  "apply_patch",
  "bash",
  "edit",
  "multiedit",
  "notebookedit",
  "patch",
  "shell",
  "write",
]);

function text(value) {
  return typeof value === "string" ? value : "";
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function lowerTool(input) {
  return text(input?.tool || input?.name || input?.id).toLowerCase();
}

function argsFrom(input, output) {
  return {
    ...object(input?.args),
    ...object(input?.parameters),
    ...object(output?.args),
    ...object(output?.parameters),
  };
}

function mapToolName(tool, args) {
  const command = text(args.command || args.cmd || args.script);
  if (tool.includes("multi")) return "MultiEdit";
  if (tool.includes("notebook")) return "NotebookEdit";
  if (tool.includes("write")) return "Write";
  if (tool.includes("edit")) return "Edit";
  if (tool.includes("patch") || tool.includes("bash") || tool.includes("shell") || command.includes("*** Begin Patch")) return "apply_patch";
  return tool || "unknown";
}

function filePathFrom(args, output) {
  return text(
    args.file_path ||
      args.filePath ||
      args.path ||
      args.filename ||
      output?.file_path ||
      output?.filePath ||
      output?.path,
  );
}

function payload(input, output) {
  const tool = lowerTool(input);
  const args = argsFrom(input, output);
  const command = text(args.command || args.cmd || args.script);
  return {
    tool_name: mapToolName(tool, args),
    tool_input: {
      file_path: filePathFrom(args, output),
      notebook_path: text(args.notebook_path || args.notebookPath),
      edits: Array.isArray(args.edits) ? args.edits : [],
      command,
    },
    tool_response: {
      filePath: filePathFrom(args, output),
    },
  };
}

function shouldRun(input, output) {
  const tool = lowerTool(input);
  const args = argsFrom(input, output);
  if (mutationTools.has(tool)) return true;
  if ([...mutationTools].some((name) => tool.includes(name))) return true;
  const command = text(args.command || args.cmd || args.script);
  return command.includes("*** Begin Patch") || command.includes("apply_patch");
}

async function streamText(stream) {
  if (!stream) return "";
  return new Response(stream).text();
}

async function runHook(root, rel, hookPayload) {
  const script = join(root, rel);
  if (!existsSync(script)) return { code: 0, stdout: "", stderr: "" };
  const proc = Bun.spawn(["bash", script], {
    cwd: root,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(JSON.stringify(hookPayload));
  proc.stdin.end();
  const [stdout, stderr, code] = await Promise.all([
    streamText(proc.stdout),
    streamText(proc.stderr),
    proc.exited,
  ]);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

function hookMessage(result) {
  return [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
}

async function log(client, level, message) {
  if (!message) return;
  try {
    await client?.app?.log?.({
      body: {
        service: "wiki-guardrails",
        level,
        message,
      },
    });
  } catch {
  }
  if (level === "error") console.error(message);
  else console.warn(message);
}

export const WikiGuardrails = async ({ client, directory, worktree }) => {
  const root = worktree || directory || process.cwd();

  return {
    "tool.execute.after": async (input, output) => {
      if (!shouldRun(input, output)) return;
      const body = payload(input, output);

      const policy = await runHook(root, ".opencode/hooks/wiki-policy-check.sh", body);
      if (policy.code !== 0) {
        throw new Error(hookMessage(policy) || `wiki-policy-check failed with exit ${policy.code}`);
      }
      await log(client, "warn", hookMessage(policy));

      const consider = await runHook(root, ".opencode/hooks/wiki-consider.sh", body);
      const considerMessage = hookMessage(consider);
      if (consider.code !== 0) {
        throw new Error(considerMessage || `wiki-consider failed with exit ${consider.code}`);
      }
      await log(client, "warn", considerMessage);

      const reindex = await runHook(root, ".opencode/hooks/wiki-reindex.sh", body);
      if (reindex.code !== 0) {
        await log(client, "warn", hookMessage(reindex) || `wiki-reindex failed with exit ${reindex.code}`);
      }
    },

    event: async ({ event }) => {
      if (event?.type !== "session.created") return;
      const audit = await runHook(root, ".opencode/hooks/wiki-drift-audit.sh", {
        tool_name: "session.created",
        tool_input: {},
        tool_response: {},
      });
      await log(client, audit.code === 0 ? "warn" : "error", hookMessage(audit));
    },
  };
};
