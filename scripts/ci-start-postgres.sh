#!/usr/bin/env bash
# Starts the disposable PostgreSQL 16 the CI tests use (DATABASE_URL
# postgresql://sinaloa:sinaloa_test@127.0.0.1:5432/sinaloa_test).
#
# It runs as a step, not as a job service: GitHub pulls services before any step, so a throttled
# anonymous registry ("toomanyrequests") there fails the job with no retry. Here the official
# image is pulled through the AWS public mirror, then Docker Hub, a bounded number of times, and
# the job fails visibly if both stay unavailable.
set -u

mirror_image=public.ecr.aws/docker/library/postgres:16-alpine
hub_image=postgres:16-alpine
container=${ENVOI_CI_POSTGRES_CONTAINER:-envoi-ci-postgres}
attempts=${ENVOI_CI_PULL_ATTEMPTS:-4}
backoff=${ENVOI_CI_PULL_BACKOFF_SECONDS:-15}
ready_seconds=${ENVOI_CI_POSTGRES_READY_SECONDS:-60}

pulled=
for attempt in $(seq 1 "$attempts"); do
  if docker pull "$mirror_image"; then
    docker tag "$mirror_image" "$hub_image" && pulled=mirror && break
  fi
  if docker pull "$hub_image"; then pulled=hub; break; fi
  if [ "$attempt" -lt "$attempts" ]; then sleep $((attempt * backoff)); fi
done
if [ -z "$pulled" ]; then
  echo "PostgreSQL image unavailable from both the mirror and Docker Hub after $attempts attempts" >&2
  exit 1
fi
echo "PostgreSQL image pulled from the $pulled"

docker run -d --name "$container" \
  -e POSTGRES_USER=sinaloa -e POSTGRES_PASSWORD=sinaloa_test -e POSTGRES_DB=sinaloa_test \
  -p 5432:5432 "$hub_image" || exit 1

# TCP readiness: the image's first-start init server listens on no TCP address, so this succeeds
# only once the real server accepts connections.
for _ in $(seq 1 "$ready_seconds"); do
  if docker exec "$container" pg_isready -h 127.0.0.1 -U sinaloa -d sinaloa_test >/dev/null 2>&1; then
    echo "PostgreSQL is ready"
    exit 0
  fi
  sleep 1
done
echo "PostgreSQL did not become ready within ${ready_seconds}s" >&2
docker logs "$container" >&2 || true
exit 1
