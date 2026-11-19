// Rebuilds the workspace image when the Dockerfile's content hash (an image label) changes.
// With a registry source, pulls a prebuilt image carrying the same label first and builds only as a fallback.
import { readFile } from "fs/promises";
import { hashDockerfile } from "./dockerfileHasher";
import { createLogger } from "../logger";
import type { IDockerClient } from "./dockerClient";

const log = createLogger("imageManager");

export const HASH_LABEL = "paodo.workspace-hash";

export class ImageManager {
  constructor(private readonly docker: IDockerClient) {}

  // Ensures the named image exists and is up-to-date with the given Dockerfile.
  // Rebuilds if the image is missing or its hash label doesn't match the current file.
  async ensureImage(imageName: string, dockerfilePath: string, source?: string): Promise<void> {
    const hash = await hashDockerfile(dockerfilePath);
    const check = await this.docker.cmd("image", "inspect", imageName);

    if (check.code === 0) {
      if (!hash) return; // can't read Dockerfile — assume image is current
      if ((await this.labelOf(imageName)) === hash) return;
      log.info({ image: imageName }, "Dockerfile changed — updating workspace image...");
    } else {
      log.info({ image: imageName }, "workspace image not found — preparing it...");
    }

    if (source && hash && (await this.pullMatching(source, imageName, hash))) return;

    log.info({ image: imageName }, "building workspace image (takes a few minutes)...");
    // Pipe the Dockerfile on stdin with an empty build context ("-") to avoid tarring
    // the mounted workspaces volume, which may contain files unreadable by the app user.
    const dockerfile = await readFile(dockerfilePath);
    const buildArgs = ["build", "-t", imageName];
    if (hash) buildArgs.push("--label", `${HASH_LABEL}=${hash}`);
    buildArgs.push("-");

    await this.docker.build(buildArgs, dockerfile);
    log.info({ image: imageName }, "workspace image ready");
  }

  // Read only when creating a container, to label it; existing containers are never compared, since drift is
  // intended (containerManager.persistence.test.ts).
  async getCurrentHash(dockerfilePath: string): Promise<string | null> {
    return hashDockerfile(dockerfilePath);
  }

  private async labelOf(image: string): Promise<string> {
    const r = await this.docker.cmd("image", "inspect", "--format", `{{index .Config.Labels "${HASH_LABEL}"}}`, image);
    return r.code === 0 ? r.stdout : "";
  }

  // True once the pulled image, built from this exact Dockerfile, is tagged as imageName. Any miss falls back to a build.
  private async pullMatching(source: string, imageName: string, hash: string): Promise<boolean> {
    log.info({ image: imageName, source }, "pulling prebuilt workspace image...");
    const pull = await this.docker.cmd("pull", source);
    if (pull.code !== 0) {
      log.warn({ source, stderr: pull.stderr }, "workspace image pull failed — building locally instead");
      return false;
    }
    const label = await this.labelOf(source);
    if (label !== hash) {
      log.warn(
        { source, label, hash },
        "pulled workspace image does not match this Dockerfile — building locally instead",
      );
      return false;
    }
    const tag = await this.docker.cmd("tag", source, imageName);
    if (tag.code !== 0) {
      log.warn({ source, stderr: tag.stderr }, "workspace image tag failed — building locally instead");
      return false;
    }
    log.info({ image: imageName, source }, "workspace image ready (pulled)");
    return true;
  }
}
