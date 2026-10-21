# syntax=docker/dockerfile:1
#
# The clean room of plan 03-39: a Debian bookworm container with Node, git, ripgrep and Claude Code 2.1.302 and
# nothing else. No plugin, skill, MCP server, hook or agent of its own; one short neutral notes file; no secret.
#
# The base image is pinned by digest. The default is Node 24.22.0 (the user's choice of 2026-10-18); the control
# script passes the pinned alternative digest instead only when the approval said so.
#
# Claude Code is installed from the official release URL. Its sha256 and the release key fingerprint are pinned
# below; the signed manifest is verified with that key, the manifest checksum for linux-x64 must equal the pinned
# value, and so must the downloaded binary. Any mismatch stops the build.

ARG BASE_IMAGE=node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
ARG CLAUDE_VERSION=2.1.302
ARG CLAUDE_SHA256=60d7eb7f12fbb28a52533fe8be5884097403562aa02dc73991a021c7067e29a5
ARG CLAUDE_RELEASE_FINGERPRINT=31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE

# ---------------------------------------------------------------------------------------------
# Stage one: fetch and verify the Claude Code binary.
FROM ${BASE_IMAGE} AS fetch
ARG CLAUDE_VERSION
ARG CLAUDE_SHA256
ARG CLAUDE_RELEASE_FINGERPRINT
RUN apt-get update && apt-get install -y --no-install-recommends curl gnupg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /fetch
RUN set -eu; \
    base="https://downloads.claude.ai/claude-code-releases/${CLAUDE_VERSION}"; \
    curl --proto '=https' --tlsv1.2 -fsSL "${base}/manifest.json" -o manifest.json; \
    curl --proto '=https' --tlsv1.2 -fsSL "${base}/manifest.json.sig" -o manifest.json.sig; \
    curl --proto '=https' --tlsv1.2 -fsSL "https://downloads.claude.ai/keys/claude-code.asc" -o claude-code.asc; \
    export GNUPGHOME="$(mktemp -d)"; \
    gpg --batch --import claude-code.asc; \
    fingerprint="$(gpg --batch --with-colons --fingerprint | awk -F: '$1 == "fpr" { print $10; exit }')"; \
    test "${fingerprint}" = "${CLAUDE_RELEASE_FINGERPRINT}"; \
    gpg --batch --verify manifest.json.sig manifest.json; \
    manifest_sha="$(node -e 'const m = JSON.parse(require("node:fs").readFileSync("manifest.json", "utf8")); process.stdout.write(String(m.platforms["linux-x64"].checksum));')"; \
    test "${manifest_sha}" = "${CLAUDE_SHA256}"; \
    curl --proto '=https' --tlsv1.2 -fsSL "${base}/linux-x64/claude" -o claude; \
    echo "${CLAUDE_SHA256}  claude" | sha256sum -c -; \
    chmod 0755 claude

# ---------------------------------------------------------------------------------------------
# Stage two: the clean room.
FROM ${BASE_IMAGE}
LABEL org.gsd-atlas.cleanroom.plan="03-39" \
      org.opencontainers.image.description="Clean-room replication environment (plan 03-39): Claude Code 2.1.302, Node, git and ripgrep; no credential."
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git ripgrep tmux procps jq less && rm -rf /var/lib/apt/lists/*
RUN useradd --uid 10001 --home-dir /home/cleanroom --create-home --shell /bin/bash cleanroom \
    && install -d -o 10001 -g 10001 -m 0700 /home/cleanroom/.claude \
    && install -d -o 10001 -g 10001 -m 0755 /work /work/tmp /work/logs
COPY --from=fetch /fetch/claude /usr/local/bin/claude
COPY --chown=10001:10001 user-claude.md /home/cleanroom/.claude/CLAUDE.md
ENV HOME=/home/cleanroom TMPDIR=/work/tmp DISABLE_UPDATES=1 DISABLE_AUTOUPDATER=1
USER cleanroom
WORKDIR /work
# The container idles until a shell or a command is run in it with docker exec; it is started with an init process.
CMD ["sleep", "infinity"]
