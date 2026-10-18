// Full drive read (mirror of workspace/overview.ts), including what uses it; manage.ts's getDrive is the bare
// registry lookup.
import { getDrive } from "./manage";
import { driveConnectionCounts, type DriveConnectionCounts } from "../connections/counts";
import type { Drive } from "@/lib/drives/store";

export type DriveOverview = Drive & {
  /** How many workspaces reach this drive, not which: the connection listing owns the detail and the
   *  id a link is removed by. Present at zero, so nothing is connected is stated rather than inferred. */
  connections: DriveConnectionCounts;
};

export function getDriveOverview(driveIdValue: unknown): DriveOverview {
  const drive = getDrive(driveIdValue);
  return { ...drive, connections: driveConnectionCounts(drive.id) };
}
