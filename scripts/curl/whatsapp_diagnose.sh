#!/usr/bin/env bash
set -euo pipefail

API_VERSION="${WHATSAPP_API_VERSION:-v22.0}"
TOKEN="${WHATSAPP_ACCESS_TOKEN:-}"
PHONE_NUMBER_ID="${WHATSAPP_PHONE_NUMBER_ID:-}"
BASE_URL="https://graph.facebook.com/${API_VERSION}"

if [[ -z "$TOKEN" ]]; then
  echo "WHATSAPP_ACCESS_TOKEN is required" >&2
  exit 1
fi

call_get() {
  local url="$1"
  echo
  echo "GET ${url}"
  curl -sS -i -H "Authorization: Bearer ${TOKEN}" "${url}"
}

extract_ids() {
  local json="$1"
  if command -v jq >/dev/null 2>&1; then
    echo "$json" | jq -r '.data[]?.id'
  else
    echo ""
  fi
}

if [[ -n "$PHONE_NUMBER_ID" ]]; then
  call_get "${BASE_URL}/${PHONE_NUMBER_ID}?fields=id,display_phone_number,verified_name"
fi

business_resp="$(curl -sS -H "Authorization: Bearer ${TOKEN}" "${BASE_URL}/me/businesses?fields=id,name")"
echo
echo "GET ${BASE_URL}/me/businesses?fields=id,name"
echo "$business_resp"

if ! command -v jq >/dev/null 2>&1; then
  echo
  echo "jq not found. Install jq for full WABA/phone discovery loop."
  exit 0
fi

business_ids="$(extract_ids "$business_resp")"
while IFS= read -r business_id; do
  [[ -z "$business_id" ]] && continue
  waba_resp="$(curl -sS -H "Authorization: Bearer ${TOKEN}" "${BASE_URL}/${business_id}/owned_whatsapp_business_accounts?fields=id,name")"
  echo
  echo "GET ${BASE_URL}/${business_id}/owned_whatsapp_business_accounts?fields=id,name"
  echo "$waba_resp"

  waba_ids="$(extract_ids "$waba_resp")"
  while IFS= read -r waba_id; do
    [[ -z "$waba_id" ]] && continue
    call_get "${BASE_URL}/${waba_id}/phone_numbers?fields=id,display_phone_number,verified_name"
  done <<< "$waba_ids"
done <<< "$business_ids"
