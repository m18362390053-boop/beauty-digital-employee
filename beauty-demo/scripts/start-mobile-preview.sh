#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
mobile_ip=${BEAUTY_MOBILE_IP:-$(ipconfig getifaddr en0 2>/dev/null || true)}
if [ -z "$mobile_ip" ]; then
  echo '未找到 Mac 的 Wi-Fi 地址。请设置 BEAUTY_MOBILE_IP 后重试。' >&2
  exit 1
fi

mkdir -p data
umask 077
mobile_cert=./data/mobile-https.crt
mobile_key=./data/mobile-https.key
if [ ! -f "$mobile_cert" ] || [ ! -f "$mobile_key" ] ||
   ! openssl x509 -in "$mobile_cert" -noout -checkend 86400 >/dev/null 2>&1 ||
   ! openssl x509 -in "$mobile_cert" -noout -text 2>/dev/null | grep -Fq "IP Address:$mobile_ip"; then
  openssl req -x509 -newkey rsa:2048 -sha256 -nodes \
    -keyout "$mobile_key" -out "$mobile_cert" -days 365 \
    -subj "/CN=$mobile_ip" \
    -addext "subjectAltName=IP:$mobile_ip,IP:127.0.0.1,DNS:localhost" >/dev/null 2>&1
fi

if [ -z "${BEAUTY_SCHEDULE_SHARE_TOKEN:-}" ]; then
  token_file=./data/schedule-share-token.txt
  if [ ! -s "$token_file" ]; then openssl rand -hex 24 > "$token_file"; fi
  BEAUTY_SCHEDULE_SHARE_TOKEN=$(tr -d '\r\n' < "$token_file")
  export BEAUTY_SCHEDULE_SHARE_TOKEN
fi

export BEAUTY_HTTPS_CERT=$mobile_cert
export BEAUTY_HTTPS_KEY=$mobile_key
export BEAUTY_HTTPS_PORT=${BEAUTY_HTTPS_PORT:-9447}
export PORT=${PORT:-3090}

printf 'Mac 顾客端：http://127.0.0.1:%s/chat/?share=%s#schedule\n' "$PORT" "$BEAUTY_SCHEDULE_SHARE_TOKEN"
printf '手机顾客端：https://%s:%s/chat/?share=%s#schedule\n' "$mobile_ip" "$BEAUTY_HTTPS_PORT" "$BEAUTY_SCHEDULE_SHARE_TOKEN"
printf '手机和 Mac 请使用上面同一组共享日程链接；手机摄像头需要 HTTPS。\n'
exec npm run dev
