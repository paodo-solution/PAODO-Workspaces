# ADR — Container-per-workspace sandbox

Status: Accepted

## Context

Agents run arbitrary shell commands and need filesystem and runtime isolation to avoid leaking packages, processes, or files between workspaces.

## Decision

Run each workspace inside its own Docker container, which the app drives via `docker exec`. The container mounts only that workspace's directory and its own durable home, runs the agent as a non-root user, sits on its own `--internal` network whose only egress is the credproxy, and has its own CPU, memory, and process caps. Only the app can reach the Docker daemon; containers never get the socket.

## Consequences

- Workspaces are isolated from each other and from the host filesystem, but not at the kernel: every container shares the host kernel, so a kernel exploit is a host compromise.
- Path checks in the app are defense in depth, not the boundary: what the agent can reach is what its container user can reach.
- Containers are disposable: state lives in the mounted workspace and home, so a container can be stopped when idle and recreated without loss.
- Environment variables, capabilities, and mounts are frozen at `docker run`; secrets therefore go per exec, while resource caps stay live-tunable with `docker update`.
- Higher resource overhead per active workspace, plus container lifecycle, image versioning, and host-capacity work to own.

## Alternatives considered

- **Single host process with chroot-like isolation**: lighter but weaker isolation and insufficient for runtime differences.
- **VM per workspace**: a kernel boundary per workspace, but too heavyweight for single-user self-hosted boxes.

## Notes

- See [`security_notes.md`](../../../security_notes.md) for the current hardening.
