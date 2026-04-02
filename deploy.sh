#!/bin/bash
set -e

echo "==> Pulling latest code..."
git pull origin main

echo "==> Building Docker image..."
docker compose build --no-cache backend

echo "==> Starting services..."
docker compose up -d

echo "==> Waiting for backend to be healthy..."
sleep 10

echo "==> Running DB init + migrations..."
docker compose exec backend node config/initDb.js

echo "==> Checking health..."
curl -sf http://localhost/api/v1/health | python3 -m json.tool

echo "==> Done! Services running:"
docker compose ps
