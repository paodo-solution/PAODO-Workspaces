// Connection id prefixes in one place. Prefixed ids name their graph, so a wrong one is refused by name instead
// of failing a lookup silently.
const PREFIX = {
  link: "link_",
  call: "call_",
} as const;

/** `link` is a drive↔workspace link; `call` is a one-way agent call between workspaces. */
export type ConnectionKind = keyof typeof PREFIX;

const KINDS = Object.keys(PREFIX) as ConnectionKind[];

export function mintConnectionId(kind: ConnectionKind): string {
  return `${PREFIX[kind]}${crypto.randomUUID()}`;
}

/** The graph an id belongs to, or null for anything that is not a connection id — a bare prefix
 *  included, since it names a kind without naming a connection. */
export function connectionKind(id: string): ConnectionKind | null {
  return KINDS.find((kind) => id.startsWith(PREFIX[kind]) && id.length > PREFIX[kind].length) ?? null;
}
