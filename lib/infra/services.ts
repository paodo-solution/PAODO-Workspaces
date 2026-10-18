// Service provider for infra singletons (getStore/getContainers), swappable in tests via setServices(). The
// agent layer must not import it; it gets them injected.
import { defaultWorkspaceStore } from "@/lib/infra/workspace/registry";
import { defaultContainerManager } from "./docker/defaultContainerManager";
import { defaultWorkspaceVersioning } from "./git";
import type { IWorkspaceStore, IContainerManager, IWorkspaceVersioning } from "./interfaces";

interface Services {
  store: IWorkspaceStore;
  containers: IContainerManager;
  versioning: IWorkspaceVersioning;
}

const defaults: Services = {
  store: defaultWorkspaceStore,
  containers: defaultContainerManager,
  versioning: defaultWorkspaceVersioning,
};

let current: Services = { ...defaults };

export function getStore(): IWorkspaceStore {
  return current.store;
}

export function getContainers(): IContainerManager {
  return current.containers;
}

export function getVersioning(): IWorkspaceVersioning {
  return current.versioning;
}

/** Test-only: override one or both services with fakes. */
export function setServices(partial: Partial<Services>): void {
  current = { ...current, ...partial };
}

/** Test-only: restore the production singletons. */
export function resetServices(): void {
  current = { ...defaults };
}
