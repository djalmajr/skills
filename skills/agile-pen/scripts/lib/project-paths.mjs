import { join, resolve } from "node:path";

export function resolveProjectPaths(project = process.cwd()) {
  const root = resolve(project);
  const design = join(root, "design");
  const contracts = join(design, "contracts");
  const evidence = join(design, "evidence");
  const cache = join(root, ".cache", "agile-pen");
  return {
    root,
    design,
    contracts,
    evidence,
    captures: join(evidence, "captures"),
    cache,
    rendererCache: join(cache, "renderer"),
    penCaptureCache: join(cache, "pen-capture")
  };
}
