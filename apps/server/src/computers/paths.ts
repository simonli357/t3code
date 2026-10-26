/**
 * Whether two paths name the same place once the file system has resolved them. Windows folds
 * case and ignores a trailing separator; `realPath` reports the canonical spelling, which need
 * not be the one a project or a user typed.
 */
export function samePath(platform: NodeJS.Platform, left: string, right: string) {
  const clean = (value: string) => {
    const trimmed = value.replace(/[\\/]+$/, "");
    return trimmed || value.slice(0, 1);
  };
  return platform === "win32"
    ? clean(left).toLowerCase() === clean(right).toLowerCase()
    : clean(left) === clean(right);
}

/** Whether `child` is `root` or lies beneath it, for POSIX or Windows spelling. */
export function isWithin(platform: NodeJS.Platform, root: string, child: string) {
  const fold = (value: string) => {
    const unified = (
      platform === "win32" ? value.replaceAll("\\", "/").toLowerCase() : value
    ).replace(/\/+$/, "");
    return unified;
  };
  const base = fold(root),
    target = fold(child);
  return target === base || target.startsWith(`${base}/`);
}
