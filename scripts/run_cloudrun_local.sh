#!/usr/bin/env bash

set -euo pipefail

ENV_FILE_INPUT="${1:-.env.cloudrun.local}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [[ "${ENV_FILE_INPUT}" = /* ]]; then
  ENV_FILE="${ENV_FILE_INPUT}"
else
  ENV_FILE="${REPO_ROOT}/${ENV_FILE_INPUT}"
fi

IMAGE_TAG="transcribealpha-local:latest"
CONTAINER_NAME="transcribealpha-local"
PORT="${PORT:-8080}"
DOCKER_PLATFORM="${DOCKER_PLATFORM:-linux/amd64}"
DEFAULT_ADC_FILE="${HOME}/.config/gcloud/application_default_credentials.json"

if ! command -v docker >/dev/null 2>&1; then
  echo "Error: docker is not installed."
  echo "Install Docker Desktop or Docker Engine and retry."
  exit 1
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Error: env file not found: ${ENV_FILE}"
  echo "Create it from template:"
  echo "  cp ${REPO_ROOT}/.env.cloudrun.example ${REPO_ROOT}/.env.cloudrun.local"
  exit 1
fi

EXTRA_DOCKER_ARGS=()
if [[ -f "${DEFAULT_ADC_FILE}" ]]; then
  EXTRA_DOCKER_ARGS+=("-v" "${DEFAULT_ADC_FILE}:/var/secrets/google/adc.json:ro")
  EXTRA_DOCKER_ARGS+=("-e" "GOOGLE_APPLICATION_CREDENTIALS=/var/secrets/google/adc.json")
else
  echo "Info: No Application Default Credentials found at:"
  echo "  ${DEFAULT_ADC_FILE}"
  echo "If auth login fails, run: gcloud auth application-default login"
fi

echo "Building ${IMAGE_TAG} (platform=${DOCKER_PLATFORM})..."
docker build \
  --platform "${DOCKER_PLATFORM}" \
  -t "${IMAGE_TAG}" \
  "${REPO_ROOT}"

docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true

echo "Starting ${CONTAINER_NAME} on http://localhost:${PORT} ..."
docker run --rm -it \
  --name "${CONTAINER_NAME}" \
  --platform "${DOCKER_PLATFORM}" \
  --cpus="1" \
  --memory="2g" \
  -p "${PORT}:8080" \
  --env-file "${ENV_FILE}" \
  -e "ENVIRONMENT=production" \
  -e "PORT=8080" \
  -e "HOST=0.0.0.0" \
  "${EXTRA_DOCKER_ARGS[@]}" \
  "${IMAGE_TAG}"
