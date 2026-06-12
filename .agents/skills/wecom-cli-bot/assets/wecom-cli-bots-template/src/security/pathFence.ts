import fs from "node:fs";
import path from "node:path";

export function assertInside(root: string, target: string): string {
  const resolvedRoot = fs.realpathSync.native(path.resolve(root));
  const resolvedTarget = resolveExistingParent(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return path.resolve(target);
  }
  throw new Error(`Path escapes workspace: ${target}`);
}

function resolveExistingParent(target: string): string {
  let current = path.resolve(target);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return fs.realpathSync.native(current);
}
