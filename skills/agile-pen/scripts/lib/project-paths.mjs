import { join, resolve } from "node:path";

export function resolveProjectPaths(project = process.cwd()) {
  const root = resolve(project);
  const design = join(root, "design");
  const contracts = join(design, "contracts");
  const cache = join(root, ".cache", "agile-pen");
  const evidence = join(cache, "evidence");
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
