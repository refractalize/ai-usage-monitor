#!/bin/sh
# No credentials or host directories are mounted; storage is disposable.
set -eu
image=${1:?Image reference required}
platform=${2:?Platform required}
container_id=
cleanup() {
  if [ -n "$container_id" ]; then
    docker rm -f "$container_id" >/dev/null
  fi
}
trap cleanup EXIT
trap 'exit 1' INT TERM

docker run --rm --platform "$platform" "$image" test -s /etc/ssl/certs/ca-certificates.crt
docker run --rm --platform "$platform" "$image" codex --version
docker run --rm --platform "$platform" "$image" claude --version
container_id=$(docker run -d --init --platform "$platform" \
  -e AI_USAGE_SCHEDULE=off -e USAGE_PROVIDERS=codex,claude \
  "$image")
ready=false
for _attempt in $(seq 1 60); do
  if docker exec "$container_id" node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
    ready=true
    break
  fi
  sleep 2
done
if [ "$ready" != true ]; then
  docker logs "$container_id"
  exit 1
fi
docker exec "$container_id" node --input-type=module -e '
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.env.AI_USAGE_DB, { readOnly: true });
if (db.prepare("SELECT COUNT(*) AS n FROM collection_attempts").get().n !== 0) process.exit(1);
db.close();
for (const provider of ["codex", "claude"]) {
  const r = await fetch(`http://127.0.0.1:3000/?provider=${provider}`);
  const html = await r.text();
  if (!r.ok || !html.includes("Loading your local timezone")) process.exit(1);
}
'
echo "Container smoke passed for $platform"
