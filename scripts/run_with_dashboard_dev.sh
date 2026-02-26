#!/usr/bin/env bash
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CORE_REPO="$(cd "${SELF_DIR}/.." && pwd)"
DASHBOARD_REPO="${DASHBOARD_REPO_PATH:-${CORE_REPO}/../dashboard-service}"

API_HOST="${API_HOST:-127.0.0.1}"
API_PORT="${API_PORT:-8000}"
DASHBOARD_HOST="${DASHBOARD_HOST:-127.0.0.1}"
DASHBOARD_PORT="${DASHBOARD_PORT:-8001}"
CORE_API_BASE_URL="${CORE_API_BASE_URL:-http://${API_HOST}:${API_PORT}}"
DATABASE_URL="${DATABASE_URL:-file:./data/ev_news_node.db}"
NEWSLETTER_NOSQL_PATH="${NEWSLETTER_NOSQL_PATH:-${CORE_REPO}/.runtime/newsletter_documents.json}"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required but not found in PATH." >&2
  exit 1
fi

if [ ! -d "${CORE_REPO}" ]; then
  echo "Core repo not found: ${CORE_REPO}" >&2
  exit 1
fi

if [ ! -d "${DASHBOARD_REPO}" ]; then
  echo "Dashboard repo not found: ${DASHBOARD_REPO}" >&2
  echo "Set DASHBOARD_REPO_PATH to your dashboard-service path." >&2
  exit 1
fi

if [ ! -d "${CORE_REPO}/node_modules" ]; then
  echo "Missing dependencies in core repo. Run: (cd ${CORE_REPO} && npm ci)" >&2
  exit 1
fi

if [ ! -d "${DASHBOARD_REPO}/node_modules" ]; then
  echo "Missing dependencies in dashboard repo. Run: (cd ${DASHBOARD_REPO} && npm ci)" >&2
  exit 1
fi

mkdir -p "${CORE_REPO}/.runtime" "${CORE_REPO}/data"

echo "Preparing core database schema..."
(
  cd "${CORE_REPO}"
  DATABASE_URL="${DATABASE_URL}" npm run prisma:generate >/dev/null
  DATABASE_URL="${DATABASE_URL}" npm run prisma:push >/dev/null
)

API_PID=""
DASHBOARD_PID=""

cleanup() {
  trap - EXIT INT TERM
  if [ -n "${API_PID}" ] && kill -0 "${API_PID}" >/dev/null 2>&1; then
    kill "${API_PID}" >/dev/null 2>&1 || true
  fi
  if [ -n "${DASHBOARD_PID}" ] && kill -0 "${DASHBOARD_PID}" >/dev/null 2>&1; then
    kill "${DASHBOARD_PID}" >/dev/null 2>&1 || true
  fi
  wait "${API_PID}" >/dev/null 2>&1 || true
  wait "${DASHBOARD_PID}" >/dev/null 2>&1 || true
}

trap cleanup EXIT INT TERM

echo "Starting core API on http://${API_HOST}:${API_PORT} ..."
(
  cd "${CORE_REPO}"
  APP_HOST="${API_HOST}" \
  APP_PORT="${API_PORT}" \
  DATABASE_URL="${DATABASE_URL}" \
  NEWSLETTER_NOSQL_PATH="${NEWSLETTER_NOSQL_PATH}" \
  npm run dev
) &
API_PID=$!

echo "Starting dashboard service on http://${DASHBOARD_HOST}:${DASHBOARD_PORT} ..."
(
  cd "${DASHBOARD_REPO}"
  APP_HOST="${DASHBOARD_HOST}" \
  APP_PORT="${DASHBOARD_PORT}" \
  CORE_API_BASE_URL="${CORE_API_BASE_URL}" \
  npm run dev
) &
DASHBOARD_PID=$!

echo ""
echo "Services started:"
echo "- API health: http://${API_HOST}:${API_PORT}/health"
echo "- Dashboard:  http://${DASHBOARD_HOST}:${DASHBOARD_PORT}/dashboard/"
echo "Press Ctrl+C to stop both services."

while true; do
  if ! kill -0 "${API_PID}" >/dev/null 2>&1; then
    echo "Core API process exited." >&2
    exit 1
  fi
  if ! kill -0 "${DASHBOARD_PID}" >/dev/null 2>&1; then
    echo "Dashboard service process exited." >&2
    exit 1
  fi
  sleep 2
done
