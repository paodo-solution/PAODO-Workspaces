// What keeps a name usable as one folder on Windows, macOS and Linux, beyond the path checks each name
// policy already makes. Workspace and drive names become folders; the VS Code extension mirrors this rule.
const FORBIDDEN = /[<>:"|?*]/;
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Why `name` cannot be a folder on every system, as the end of "<Noun> name …", or null when it can. */
export function portableNameProblem(name: string): string | null {
  if (FORBIDDEN.test(name)) return 'cannot contain any of < > : " | ? *';
  if (name.endsWith(".")) return "cannot end with a dot";
  if (WINDOWS_DEVICE.test(name)) return `cannot be "${name}", a reserved name on Windows`;
  return null;
}
