import path from "node:path";

export function isPathInside(baseDir, targetPath) {
  const base = path.resolve(baseDir);
  const target = path.resolve(targetPath);
  const relative = path.relative(base, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function assertPathInside(baseDir, targetPath, message = "Path is outside the allowed directory") {
  if (!isPathInside(baseDir, targetPath)) {
    throw Object.assign(new Error(message), { statusCode: 403 });
  }
  return path.resolve(targetPath);
}
