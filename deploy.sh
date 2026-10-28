#!/bin/bash
# Build, back up, migrate and (re)start the stack. Works for the first deploy and for updates.
#   ./deploy.sh                 normal deploy
#   SEED_CATALOG=1 ./deploy.sh  also load the launch catalog (first deploy only; see config/seeds/catalog_seed.js)
set -euo pipefail

if [ ! -f .env ]; then
  echo ".env is missing: copy .env.example to .env and fill it in first" >&2
  exit 1
fi

if [ -d .git ]; then
  echo "==> Pulling latest code..."
  git pull origin main
fi

echo "==> Building Docker image..."
docker compose build backend

echo "==> Starting the database and Redis..."
docker compose up -d --wait postgres redis

echo "==> Backing up the database..."
mkdir -p backups
STAMP=$(date +%Y%m%d-%H%M%S)
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' \
  > "backups/curevie-$STAMP.dump"

echo "==> Backing up uploaded files (images and medical files)..."
docker compose run --rm --no-deps -T backend tar -czf - -C /app uploads \
  > "backups/uploads-$STAMP.tar.gz"

# Keep the 10 most recent backups of each kind.
ls -1t backups/curevie-*.dump 2>/dev/null | tail -n +11 | xargs -r rm -f
ls -1t backups/uploads-*.tar.gz 2>/dev/null | tail -n +11 | xargs -r rm -f

echo "==> Running migrations with the new image (stops here if a migration fails)..."
docker compose run --rm --no-deps backend node config/initDb.js

if [ "${SEED_CATALOG:-0}" = "1" ]; then
  echo "==> Loading the launch catalog (existing items are left untouched)..."
  docker compose run --rm --no-deps backend node config/seeds/catalog_seed.js
fi

echo "==> Starting services..."
docker compose up -d

echo "==> Waiting for the backend to be healthy..."
for i in $(seq 1 30); do
  # Checked inside the container: port 80 only answers with a redirect to HTTPS.
  if docker compose exec -T backend wget -qO- http://localhost:5000/api/v1/health > /dev/null 2>&1; then
    echo "==> Healthy"
    docker compose ps
    exit 0
  fi
  sleep 5
done

echo "Backend did not become healthy in time" >&2
docker compose logs --tail=100 backend >&2
exit 1
