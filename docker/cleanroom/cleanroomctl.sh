#!/usr/bin/env bash
# cleanroomctl.sh: the only remote-control surface of the clean room (plan 03-39).
#
# It reaches the Docker host over ssh (CLEANROOM_SSH names the approved target; there is no default) and touches
# exactly five objects, all created by this script and all carrying the label below:
#   container  gsd-atlas-cleanroom
#   image      gsd-atlas-cleanroom:03-39
#   network    gsd-atlas-cleanroom-net
#   volumes    gsd-atlas-cleanroom-home and gsd-atlas-cleanroom-work
# Every remote command is built from these fixed names. No name comes from the environment or from an argument,
# there is no bulk or pattern removal, a removal reads the label first, nothing is published, no socket is mounted,
# and no elevated rights are used. Read-only host facts: `probe`. Everything else needs the approval of Task 3.
#
# bash 3.2 compatible (the maintainer machine), no Windows branch.
set -euo pipefail

readonly LABEL_KEY="org.gsd-atlas.cleanroom.plan"
readonly LABEL_VALUE="03-39"
readonly CONTAINER="gsd-atlas-cleanroom"
readonly IMAGE="gsd-atlas-cleanroom:03-39"
readonly NETWORK="gsd-atlas-cleanroom-net"
readonly VOLUME_HOME="gsd-atlas-cleanroom-home"
readonly VOLUME_WORK="gsd-atlas-cleanroom-work"
readonly OWN_OBJECTS=("container ${CONTAINER}" "image ${IMAGE}" "network ${NETWORK}" "volume ${VOLUME_HOME}" "volume ${VOLUME_WORK}")

readonly CONTAINER_USER="cleanroom"
readonly CONTAINER_REPO="/work/gsd-atlas"
readonly BUNDLE_PATH="/work/in/atlas-cleanroom.bundle"

# The pinned alternative base, passed to the build only for NODE_MAJOR=26. The default (24) is the Dockerfile's own.
readonly NODE_26_BASE="node:26.12.0-bookworm-slim@sha256:298992629d69bbd5b2b03ad57094d8e4fcb3a8eeb7c4e25d29de656519568913"

die() {
  printf 'cleanroomctl: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
usage: CLEANROOM_SSH=<ssh target> bash docker/cleanroom/cleanroomctl.sh <subcommand> [arguments]

  probe                          read-only facts of the Docker host; shows whether an own object already exists (exit 3 if so)
  build                          build the image on the host from a tar stream of Dockerfile and user-claude.md (NODE_MAJOR=24|26)
  up                             create the labelled network and volumes, then start the container with explicit limits
                                 (CPUS, MEM, PIDS, SHARES; defaults 4, 12g, 2048, 512)
  load-bundle <file> <sha256>    stream a git bundle into the container and compare its sha256 on both sides
  exec [--detach <log>] <cmd>    run a command in the container as the cleanroom user in the checkout (detached: log under /work/logs)
  shell                          interactive shell in the container (ssh -t ... docker exec -it ...)
  status                         the own objects by exact name, with their labels, state and limits
  fetch <container path> <dir>   copy a path under /work out of the container into a local directory
  verify-provision               the checks of Task 4; prints `provision: ok` on success
  preflight                      the checks and the four probe sessions of Task 6 (uses Max allowance); prints `preflight: ok`
  down remove|keep-stopped|keep-running
                                 log out of Claude Code first, then act; removal reads the label on each object first
  help                           this text

Environment: CLEANROOM_SSH (required, no default), NODE_MAJOR, CPUS, MEM, PIDS, SHARES, TOOLING_COMMIT (verify-provision).
EOF
}

# ---------------------------------------------------------------------------------------------
# The ssh target and the remote helpers

require_ssh() {
  : "${CLEANROOM_SSH:?CLEANROOM_SSH must name the approved ssh target (there is no default)}"
  case "${CLEANROOM_SSH}" in
    -*) die "CLEANROOM_SSH must not start with a dash" ;;
  esac
  [[ "${CLEANROOM_SSH}" =~ ^[A-Za-z0-9._@:-]+$ ]] || die "CLEANROOM_SSH may hold only letters, digits and . _ @ : -"
}

# One command string, run by the remote shell. Callers build it from constants and validated values only.
remote() {
  require_ssh
  ssh -o BatchMode=yes -o ConnectTimeout=10 -- "${CLEANROOM_SSH}" "$@"
}

remote_tty() {
  require_ssh
  ssh -t -o ConnectTimeout=10 -- "${CLEANROOM_SSH}" "$@"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  else
    shasum -a 256 "$1" | awk '{ print $1 }'
  fi
}

# A name is acted on only when it is one of the five own objects.
require_own() {
  case "$1" in
    "${CONTAINER}" | "${IMAGE}" | "${NETWORK}" | "${VOLUME_HOME}" | "${VOLUME_WORK}") ;;
    *) die "refusing: '$1' is not one of the five own objects" ;;
  esac
}

object_exists() {
  local kind="$1" name="$2"
  require_own "${name}"
  remote "docker ${kind} inspect ${name} >/dev/null 2>&1 && echo yes || echo no"
}

label_of() {
  local kind="$1" name="$2" field
  require_own "${name}"
  case "${kind}" in
    container | image) field=".Config.Labels" ;;
    network | volume) field=".Labels" ;;
    *) die "unknown object kind '${kind}'" ;;
  esac
  remote "docker ${kind} inspect --format '{{index ${field} \"${LABEL_KEY}\"}}' ${name} 2>/dev/null || true"
}

require_label() {
  local kind="$1" name="$2" got
  got="$(label_of "${kind}" "${name}")"
  [ "${got}" = "${LABEL_VALUE}" ] || die "refusing: ${kind} ${name} does not carry ${LABEL_KEY}=${LABEL_VALUE} (read '${got}')"
}

# The one place that removes anything: the label is read first, then the object goes, by its exact name.
remove_object() {
  local kind="$1" name="$2"
  require_own "${name}"
  require_label "${kind}" "${name}"
  case "${kind}" in
    container)
      remote "docker stop ${name} >/dev/null 2>&1 || true"
      remote "docker rm ${name}"
      ;;
    network) remote "docker network rm ${name}" ;;
    image) remote "docker image rm ${name}" ;;
    volume) remote "docker volume rm ${name}" ;;
    *) die "unknown object kind '${kind}'" ;;
  esac
  printf 'removed %s %s\n' "${kind}" "${name}"
}

own_present() {
  local pair kind name present=""
  for pair in "${OWN_OBJECTS[@]}"; do
    kind="${pair%% *}"
    name="${pair#* }"
    if [ "$(object_exists "${kind}" "${name}")" = yes ]; then
      present="${present}${kind}:${name} "
    fi
  done
  printf '%s' "${present}"
}

# ---------------------------------------------------------------------------------------------
# probe, build, up

cmd_probe() {
  require_ssh
  echo "--- docker server version"
  remote "docker version --format '{{.Server.Version}}'"
  echo "--- containers (names and states)"
  remote "docker ps -a --format '{{.Names}} {{.State}}'"
  echo "--- images"
  remote "docker images --format '{{.Repository}}:{{.Tag}}'"
  echo "--- volumes"
  remote "docker volume ls --format '{{.Name}}'"
  echo "--- networks"
  remote "docker network ls --format '{{.Name}}'"
  echo "--- disk of the docker data directory"
  remote "df -h \"\$(docker info --format '{{.DockerRootDir}}')\""
  echo "--- memory (MiB)"
  remote "free -m"
  echo "--- cpus"
  remote "nproc"
  echo "--- load"
  remote "uptime"
  local present
  present="$(own_present)"
  if [ -n "${present}" ]; then
    echo "own objects present: ${present}"
    echo "probe: stop (reuse or removal is the human's choice)"
    exit 3
  fi
  echo "own objects present: none"
  echo "probe: ok"
}

cmd_build() {
  require_ssh
  local base_args=() choice="${NODE_MAJOR:-24}" dir
  case "${choice}" in
    24) ;;
    26) base_args=(--build-arg "BASE_IMAGE=${NODE_26_BASE}") ;;
    *) die "NODE_MAJOR must be 24 or 26" ;;
  esac
  if [ "$(object_exists image "${IMAGE}")" != no ]; then
    die "the image already exists: show it with status; reuse it or remove it with down remove"
  fi
  dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local build_args=(docker build --label "${LABEL_KEY}=${LABEL_VALUE}" --tag "${IMAGE}")
  if [ "${#base_args[@]}" -gt 0 ]; then
    build_args+=("${base_args[@]}")
  fi
  build_args+=(-)
  # The build context is a tar stream of the two image files; nothing is staged on the host.
  COPYFILE_DISABLE=1 tar -C "${dir}" -cf - Dockerfile user-claude.md | remote "$(printf '%q ' "${build_args[@]}")"
  echo "image id: $(remote "docker image inspect --format '{{.Id}}' ${IMAGE}")"
  echo "image label: $(label_of image "${IMAGE}")"
}

cmd_up() {
  require_ssh
  local cpus="${CPUS:-4}" mem="${MEM:-12g}" pids="${PIDS:-2048}" shares="${SHARES:-512}"
  [[ "${cpus}" =~ ^[0-9]+(\.[0-9]+)?$ ]] || die "CPUS must be a number"
  [[ "${mem}" =~ ^[0-9]+g$ ]] || die "MEM must look like 12g"
  [[ "${pids}" =~ ^[0-9]+$ ]] || die "PIDS must be a whole number"
  [[ "${shares}" =~ ^[0-9]+$ ]] || die "SHARES must be a whole number"
  [ "$(object_exists image "${IMAGE}")" = yes ] || die "the image is missing: run build first"
  require_label image "${IMAGE}"
  local pair kind name
  for pair in "${OWN_OBJECTS[@]}"; do
    kind="${pair%% *}"
    name="${pair#* }"
    if [ "${kind}" != image ] && [ "$(object_exists "${kind}" "${name}")" != no ]; then
      die "a stale ${kind} ${name} exists: show it with status; reuse or removal is the human's choice"
    fi
  done
  remote "$(printf '%q ' docker network create --driver bridge --label "${LABEL_KEY}=${LABEL_VALUE}" "${NETWORK}")"
  remote "$(printf '%q ' docker volume create --label "${LABEL_KEY}=${LABEL_VALUE}" "${VOLUME_HOME}")"
  remote "$(printf '%q ' docker volume create --label "${LABEL_KEY}=${LABEL_VALUE}" "${VOLUME_WORK}")"
  local run_args=(docker run -d --init --name "${CONTAINER}" --hostname "${CONTAINER}" --network "${NETWORK}" \
    --label "${LABEL_KEY}=${LABEL_VALUE}" --cpus "${cpus}" --memory "${mem}" --memory-swap "${mem}" \
    --pids-limit "${pids}" --cpu-shares "${shares}" --cap-drop ALL --security-opt no-new-privileges:true --restart no \
    -v "${VOLUME_HOME}:/home/cleanroom" -v "${VOLUME_WORK}:/work" "${IMAGE}")
  remote "$(printf '%q ' "${run_args[@]}")"
  cmd_status
}

# ---------------------------------------------------------------------------------------------
# exec, shell, load-bundle, fetch, status

cmd_exec() {
  require_ssh
  local logname=""
  if [ "${1:-}" = "--detach" ]; then
    logname="${2:-}"
    [[ "${logname}" =~ ^[A-Za-z0-9._-]+$ ]] || die "--detach needs a log name of letters, digits and . _ -"
    shift 2
  fi
  [ "$#" -gt 0 ] || die "exec needs a command"
  local cmd
  cmd="$(printf '%q ' "$@")"
  if [ -n "${logname}" ]; then
    remote "docker exec -d -u ${CONTAINER_USER} -w ${CONTAINER_REPO} ${CONTAINER} bash -c 'exec \"\$@\" >> /work/logs/${logname}.log 2>&1' _ ${cmd}"
    echo "detached; log: /work/logs/${logname}.log"
  else
    remote "docker exec -i -u ${CONTAINER_USER} -w ${CONTAINER_REPO} ${CONTAINER} ${cmd}"
  fi
}

cmd_shell() {
  require_ssh
  echo "running: ssh -t <target> docker exec -it -u ${CONTAINER_USER} ${CONTAINER} bash -l"
  remote_tty "docker exec -it -u ${CONTAINER_USER} ${CONTAINER} bash -l"
}

cmd_load_bundle() {
  require_ssh
  local file="${1:-}" want="${2:-}" have got
  [ -f "${file}" ] || die "load-bundle needs the bundle file as its first argument"
  [[ "${want}" =~ ^[0-9a-f]{64}$ ]] || die "load-bundle needs the expected sha256 (64 lower-case hex digits) as its second argument"
  have="$(sha256_of "${file}")"
  [ "${have}" = "${want}" ] || die "the local sha256 differs from the one given"
  remote "docker exec -i -u ${CONTAINER_USER} ${CONTAINER} sh -c 'mkdir -p /work/in && cat > ${BUNDLE_PATH}'" < "${file}"
  got="$(remote "docker exec -u ${CONTAINER_USER} ${CONTAINER} sha256sum ${BUNDLE_PATH}" | awk '{ print $1 }')"
  [ "${got}" = "${want}" ] || die "the sha256 in the container differs from the one given"
  echo "bundle: ok sha256=${want}"
}

cmd_fetch() {
  require_ssh
  local src="${1:-}" dest="${2:-}" parent base
  [[ "${src}" =~ ^/work/[A-Za-z0-9._/-]+$ ]] || die "fetch takes an absolute path under /work made of letters, digits and . _ / -"
  case "${src}" in
    *..* | */.claude* | *credentials*) die "refusing to fetch that path" ;;
  esac
  [ -d "${dest}" ] || die "fetch needs an existing local directory as its second argument"
  parent="$(dirname "${src}")"
  base="$(basename "${src}")"
  remote "docker exec -u ${CONTAINER_USER} ${CONTAINER} tar -C ${parent} -cf - ${base}" | tar -C "${dest}" -xf -
  echo "fetched ${src}; sha256 of each file:"
  (
    cd "${dest}"
    find "${base}" -type f | sort | while IFS= read -r file; do
      printf '%s  %s\n' "$(sha256_of "${file}")" "${file}"
    done
  )
}

cmd_status() {
  require_ssh
  local pair kind name label state
  for pair in "${OWN_OBJECTS[@]}"; do
    kind="${pair%% *}"
    name="${pair#* }"
    state="$(object_exists "${kind}" "${name}")"
    if [ "${state}" = yes ]; then
      label="$(label_of "${kind}" "${name}")"
      printf '%s %s: present, %s=%s\n' "${kind}" "${name}" "${LABEL_KEY}" "${label:-<none>}"
    else
      printf '%s %s: absent\n' "${kind}" "${name}"
    fi
  done
  if [ "$(object_exists container "${CONTAINER}")" = yes ]; then
    remote "docker container inspect --format 'state={{.State.Status}} user={{.Config.User}} network={{.HostConfig.NetworkMode}} nanocpus={{.HostConfig.NanoCpus}} memory={{.HostConfig.Memory}} swap={{.HostConfig.MemorySwap}} pids={{.HostConfig.PidsLimit}} shares={{.HostConfig.CpuShares}} ports={{json .NetworkSettings.Ports}} capdrop={{json .HostConfig.CapDrop}} secopt={{json .HostConfig.SecurityOpt}} mounts={{range .Mounts}}{{.Name}}:{{.Destination}} {{end}}' ${CONTAINER}"
  fi
}

# ---------------------------------------------------------------------------------------------
# The checks that run inside the container (their scripts arrive on stdin; nothing is staged)

provision_script() {
  cat <<'EOS'
set -u
expect_node="$1"
tooling_commit="$2"
fail=0
ok() { printf 'ok: %s\n' "$1"; }
bad() { printf 'FAIL: %s\n' "$1"; fail=1; }

version="$(claude --version 2>&1 | head -n 1)"
if [ "$version" = "2.1.302 (Claude Code)" ]; then ok "claude --version is $version"; else bad "claude --version prints '$version'"; fi

doctor_line="$(timeout 60 claude doctor 2>&1 | grep -i 'auto-update' | head -n 1 || true)"
if printf '%s' "$doctor_line" | grep -qi 'disabled'; then ok "claude doctor: $doctor_line"; else bad "claude doctor does not report auto-updates as disabled ('$doctor_line')"; fi

node_version="$(node --version)"
if [ "$node_version" = "$expect_node" ]; then ok "node $node_version"; else bad "node is $node_version, expected $expect_node"; fi
if [ "$(printf '%s\n%s\n' v24.16.0 "$node_version" | sort -V | head -n 1)" = v24.16.0 ]; then ok "node is at or above v24.16.0"; else bad "node is below v24.16.0"; fi

if [ "$(id -u)" = 10001 ]; then ok "uid 10001"; else bad "uid is $(id -u)"; fi

names="$(env | cut -d= -f1 | grep -E '^(ANTHROPIC_|CLAUDE_CODE_|AWS_|GOOGLE_|AZURE_)' || true)"
if [ -z "$names" ]; then ok "no provider, API-key or token variable"; else bad "variables present: $names"; fi
if [ "${DISABLE_UPDATES:-}" = 1 ] && [ "${DISABLE_AUTOUPDATER:-}" = 1 ]; then ok "update controls set"; else bad "update controls are not both 1"; fi

listing="$(ls -A "$HOME/.claude")"
if [ "$listing" = "CLAUDE.md" ]; then ok "~/.claude holds only CLAUDE.md"; else bad "~/.claude holds: $listing"; fi
if printf '# Notes\n\nThis is a general-purpose Linux development machine.\n' | diff -q - "$HOME/.claude/CLAUDE.md" >/dev/null; then ok "notes file is the exact neutral text"; else bad "notes file differs"; fi

printf 'record: %s\n' "$(rg --version | head -n 1)"
printf 'record: %s\n' "$(git --version)"
printf 'record: os.totalmem=%s nproc=%s\n' "$(node -p "require('node:os').totalmem()")" "$(nproc)"
printf 'record: cgroup memory.max=%s cpu.max=%s\n' "$(cat /sys/fs/cgroup/memory.max 2>/dev/null || echo n/a)" "$(cat /sys/fs/cgroup/cpu.max 2>/dev/null || echo n/a)"

cd /work/gsd-atlas || { bad "/work/gsd-atlas is missing"; echo "provision: FAILED"; exit 1; }
if [ "$tooling_commit" != "-" ]; then
  head_commit="$(git rev-parse HEAD)"
  if [ "$head_commit" = "$tooling_commit" ]; then ok "HEAD equals the tooling commit"; else bad "HEAD is $head_commit"; fi
fi
if [ -z "$(git status --short)" ]; then ok "git status is empty"; else bad "git status is not empty"; fi
if [ -f dist/bin/gsd-atlas.js ]; then ok "the atlas build exists"; else bad "dist/bin/gsd-atlas.js is missing"; fi

corpus="$(find /work/prep -mindepth 1 -maxdepth 1 -type d 2>/dev/null | head -n 1)"
if [ -z "$corpus" ]; then
  bad "no prepared corpus under /work/prep"
else
  record="$corpus/.eval-prepared.json"
  if [ "$(jq -r .sha "$record")" = 10ac3a7a947903ba50f538a907af036744d759d5 ] \
    && [ "$(jq -r .npmCi "$record")" = true ] \
    && [ "$(jq -r .typescriptVersion "$record")" = 6.0.3 ] \
    && [ "$(jq -r .lockSha256 "$record")" = dccc7f1cc3cd7ee9b8d071a03def1e7a4a535cc68a1828df2b797c6aecb357fb ]; then
    ok "prepared corpus record matches the registered one"
  else
    bad "prepared corpus record differs from the registered one"
  fi
  extras="$(ls -A "$corpus" | grep -E '^(CLAUDE\.md|AGENTS\.md|\.claude|\.mcp\.json)$' || true)"
  if [ -z "$extras" ]; then ok "no project memory or configuration in the corpus"; else bad "corpus holds: $extras"; fi
fi

if [ "$fail" = 0 ]; then echo "provision: ok"; else echo "provision: FAILED"; exit 1; fi
EOS
}

# The registered plan command, for the gate and the first ten cells (starts no session, needs no login).
plan_check_script() {
  cat <<'EOS'
corpus="$(find /work/prep -mindepth 1 -maxdepth 1 -type d | head -n 1)"
cd /work/gsd-atlas || exit 1
out="$(node scripts/eval/harness.ts plan --scored --questions scripts/eval/questions/gsd-core.questions.json --answers scripts/eval/questions/gsd-core.answers.json --corpus-dir "$corpus" --out-dir /work/cleanroom-run --arms atlas,grep --runs 3 --concurrency 2 --seed 20261017 --model claude-sonnet-5-5 --prereg docs/eval/preregistration.md 2>&1)" || { printf '%s\n' "$out"; echo "plan: FAILED"; exit 1; }
printf '%s\n' "$out" | grep -E '^(gate|mode|questions|cells|seed|concurrency):|^ +(atlas|grep): '
first="$(printf '%s\n' "$out" | sed -n '/^first 10 cells:/,/^flags:/p' | grep -E '^ +[0-9]+\. ' | sed -E 's/^ +[0-9]+\. //' | tr '\n' ' ')"
want="q-029|grep|2 q-029|atlas|2 q-034|grep|1 q-034|atlas|1 q-066|grep|1 q-066|atlas|1 q-028|atlas|2 q-028|grep|2 q-071|grep|2 q-071|atlas|2 "
printf 'first ten cells: %s\n' "$first"
if printf '%s\n' "$out" | grep -q '^gate: ok' && printf '%s\n' "$out" | grep -q '^cells: 450$' && [ "$first" = "$want" ]; then echo "plan: ok"; else echo "plan: FAILED"; exit 1; fi
EOS
}

preflight_script() {
  cat <<'EOS'
set -u
fail=0
ok() { printf 'ok: %s\n' "$1"; }
bad() { printf 'FAIL: %s\n' "$1"; fail=1; }

auth="$(claude auth status 2>/dev/null | jq -r '"loggedIn=\(.loggedIn) authMethod=\(.authMethod) apiProvider=\(.apiProvider) subscriptionType=\(.subscriptionType)"' 2>/dev/null || true)"
printf 'auth: %s\n' "$auth"
if [ "$auth" = "loggedIn=true authMethod=claude.ai apiProvider=firstParty subscriptionType=max" ]; then ok "Max login through claude.ai"; else bad "the login is not the Max login through claude.ai"; fi

names="$(env | cut -d= -f1 | grep -E '^(ANTHROPIC_|CLAUDE_CODE_USE_|AWS_|GOOGLE_|AZURE_|CLAUDE_CODE_OAUTH_TOKEN$)' || true)"
if [ -z "$names" ]; then ok "no provider, API-key or token variable"; else bad "variables present: $names"; fi

printf 'home entries: %s\n' "$(ls -A "$HOME/.claude" | tr '\n' ' ')"
if ls -A "$HOME/.claude" | grep -qxE 'hooks|skills|agents|commands|plugins'; then bad "the home holds a hooks, skills, agents, commands or plugins entry"; else ok "no hooks, skills, agents, commands or plugins entry in the home"; fi
if [ -f "$HOME/.claude/settings.json" ]; then
  keys="$(jq -r 'keys[]' "$HOME/.claude/settings.json" | tr '\n' ' ')"
  printf 'settings.json keys: %s\n' "$keys"
  if printf '%s\n' $keys | grep -qxE 'hooks|permissions|env|enabledPlugins|mcpServers|statusLine|apiKeyHelper'; then bad "settings.json holds a forbidden key"; else ok "settings.json holds none of the forbidden keys"; fi
fi
printf 'doctor: %s\n' "$(timeout 60 claude doctor 2>&1 | grep -i 'auto-update' | head -n 1 || true)"

cd /work/gsd-atlas || exit 1
corpus="$(find /work/prep -mindepth 1 -maxdepth 1 -type d | head -n 1)"
total=0
for arm in atlas grep control-harness control-default; do
  line="$(nice -n 10 node scripts/cleanroom/probe.ts --arm "$arm" --corpus-dir "$corpus" --out-dir /work/probe)" || true
  printf 'probe %s: %s\n' "$arm" "$line"
  if [ -z "$line" ]; then bad "probe $arm printed nothing"; continue; fi
  if [ "$(printf '%s' "$line" | jq -r '.status')" != ok ]; then bad "probe $arm did not end ok"; fi
  if [ "$(printf '%s' "$line" | jq -r '.hookEvents')" != 0 ]; then bad "probe $arm saw a hook event"; fi
  if [ "$(printf '%s' "$line" | jq -r '.rateLimit.isUsingOverage')" != false ] || [ "$(printf '%s' "$line" | jq -r '.rateLimit.overageEnabled')" != false ]; then bad "probe $arm shows paid usage or does not rule it out"; fi
  case "$arm" in
    atlas | grep)
      if [ "$(printf '%s' "$line" | jq -r '.signatureDiffs | length')" != 0 ]; then bad "probe $arm differs from the registered init signature"; fi
      if [ "$(printf '%s' "$line" | jq -r '.apiKeySource')" != none ] || [ "$(printf '%s' "$line" | jq -r '.claudeCodeVersion')" != 2.1.302 ]; then bad "probe $arm: apiKeySource or version differs"; fi
      ;;
  esac
  total="$(printf '%s %s' "$total" "$(printf '%s' "$line" | jq -r '.costUsd // 0')" | awk '{ print $1 + $2 }')"
done
printf 'probe cost (notional USD): %s\n' "$total"
if awk -v t="$total" 'BEGIN { exit !(t <= 0.20) }'; then ok "probes within the 0.20 USD cap"; else bad "probes cost more than 0.20 USD"; fi

node scripts/cleanroom/check-chunk.ts --out-dir /work/probe --streams-only
if node scripts/cleanroom/check-chunk.ts --out-dir /work/probe --streams-only | tail -n 1 | grep -qx 'check: ok'; then ok "stream check of the probes"; else bad "stream check of the probes stops"; fi

if [ "$fail" = 0 ]; then echo "preflight: ok"; else echo "preflight: FAILED"; exit 1; fi
EOS
}

cmd_verify_provision() {
  require_ssh
  local expect="v24.22.0" tooling="${TOOLING_COMMIT:--}" container_state
  case "${NODE_MAJOR:-24}" in
    24) ;;
    26) expect="v26.12.0" ;;
    *) die "NODE_MAJOR must be 24 or 26" ;;
  esac
  [[ "${tooling}" =~ ^([0-9a-f]{40}|[0-9a-f]{64}|-)$ ]] || die "TOOLING_COMMIT must be a full commit id"
  for pair in "${OWN_OBJECTS[@]}"; do
    require_label "${pair%% *}" "${pair#* }"
  done
  container_state="$(remote "docker container inspect --format '{{.State.Status}} ports={{json .NetworkSettings.Ports}}' ${CONTAINER}")"
  case "${container_state}" in
    "running ports={}") echo "ok: container running, no published port" ;;
    *) die "the container is not running with an empty port map (${container_state})" ;;
  esac
  provision_script | remote "docker exec -i -u ${CONTAINER_USER} ${CONTAINER} bash -s -- ${expect} ${tooling}"
  plan_check_script | remote "docker exec -i -u ${CONTAINER_USER} ${CONTAINER} bash -s"
}

cmd_preflight() {
  require_ssh
  preflight_script | remote "docker exec -i -u ${CONTAINER_USER} -w ${CONTAINER_REPO} ${CONTAINER} bash -s"
  plan_check_script | remote "docker exec -i -u ${CONTAINER_USER} ${CONTAINER} bash -s"
  echo "preflight: ok"
}

# ---------------------------------------------------------------------------------------------
# down

cmd_down() {
  require_ssh
  local choice="${1:-}"
  case "${choice}" in
    remove | keep-stopped | keep-running) ;;
    *) die "down needs one of: remove, keep-stopped, keep-running" ;;
  esac
  if [ "$(object_exists container "${CONTAINER}")" = yes ]; then
    require_label container "${CONTAINER}"
    # The login is removed first, whatever the choice; a stopped container is started once for that.
    remote "docker start ${CONTAINER} >/dev/null 2>&1 || true"
    if remote "docker exec -u ${CONTAINER_USER} ${CONTAINER} claude auth logout"; then
      echo "logged out of Claude Code in the container"
    else
      echo "note: the logout did not complete; check it before relying on the container being logged out" >&2
    fi
  fi
  case "${choice}" in
    keep-running)
      echo "reminder: the container is still running and holds no login; remove it later with: down remove"
      ;;
    keep-stopped)
      if [ "$(object_exists container "${CONTAINER}")" = yes ]; then
        remote "docker stop ${CONTAINER}"
      fi
      echo "reminder: the container is stopped; remove everything later with: down remove"
      ;;
    remove)
      local pair kind name
      # Container first, then the network, the volumes and the image; each is skipped when it is already gone.
      for pair in "container ${CONTAINER}" "network ${NETWORK}" "volume ${VOLUME_HOME}" "volume ${VOLUME_WORK}" "image ${IMAGE}"; do
        kind="${pair%% *}"
        name="${pair#* }"
        if [ "$(object_exists "${kind}" "${name}")" = yes ]; then
          remove_object "${kind}" "${name}"
        else
          printf '%s %s: already absent\n' "${kind}" "${name}"
        fi
      done
      ;;
  esac
  cmd_status
}

main() {
  local sub="${1:-help}"
  if [ "$#" -gt 0 ]; then
    shift
  fi
  case "${sub}" in
    help | -h | --help) usage ;;
    probe) cmd_probe ;;
    build) cmd_build ;;
    up) cmd_up ;;
    load-bundle) cmd_load_bundle "$@" ;;
    exec) cmd_exec "$@" ;;
    shell) cmd_shell ;;
    status) cmd_status ;;
    fetch) cmd_fetch "$@" ;;
    verify-provision) cmd_verify_provision ;;
    preflight) cmd_preflight ;;
    down) cmd_down "$@" ;;
    *)
      usage >&2
      die "unknown subcommand: ${sub}"
      ;;
  esac
}

main "$@"
