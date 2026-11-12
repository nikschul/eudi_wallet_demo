#!/usr/bin/env bash
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<'HELP'
Start mit automatischem HTTPS-Tunnel (Docker, Compose und curl erforderlich):
  bash scripts/demo.sh workshop [start]
  bash scripts/demo.sh issuer [start] --workshop-url https://DEINE-ZENTRALE
  bash scripts/demo.sh workshop status
  bash scripts/demo.sh issuer stop

Optionen:
  --workshop-url URL   Adresse der Zentrale; wird nur lokal gemerkt.
  --timeout SEKUNDEN  Wartezeit je Startphase, 1 bis 600 (Standard: 120).
  --help              Diese Hilfe anzeigen.

Stoppen erhält die Docker-Volumes. Quick-Tunnel-Adressen können sich danach ändern.
HELP
}

fail() { printf 'Fehler: %s\n' "$*" >&2; exit 1; }

if [[ "${1:-}" == "--help" ]]; then usage; exit 0; fi
role="${1:-}"
[[ "$role" == workshop || "$role" == issuer ]] || { usage >&2; exit 64; }
shift
operation=start
case "${1:-}" in start|stop|status) operation="$1"; shift ;; esac
timeout=120
workshop_argument=""
while (( $# )); do
  case "$1" in
    --help) usage; exit 0 ;;
    --workshop-url)
      (( $# >= 2 )) || fail "Nach --workshop-url fehlt die Adresse."
      workshop_argument="$2"; shift 2 ;;
    --timeout)
      (( $# >= 2 )) || fail "Nach --timeout fehlt die Wartezeit."
      timeout="$2"; shift 2 ;;
    *) fail "Unbekanntes Argument: $1" ;;
  esac
done
[[ "$timeout" =~ ^[1-9][0-9]{0,2}$ ]] && (( 10#$timeout <= 600 )) || fail "Die Wartezeit muss zwischen 1 und 600 Sekunden liegen."
[[ -z "$workshop_argument" || "$role" == issuer ]] || fail "--workshop-url gehört zum Issuer-Start."

for command in docker curl; do
  command -v "$command" >/dev/null || fail "$command fehlt. Bitte zuerst die Voraussetzungen installieren."
done
docker compose version >/dev/null || fail "Docker Compose ist nicht verfügbar."
docker info >/dev/null || fail "Der Docker-Daemon ist nicht erreichbar. Bitte Dienst und Zugriffsrechte prüfen."

state="$root/.demo"
state_file="$state/$role.env"
base="$root/compose.yaml"
[[ "$role" == issuer ]] && base="$root/compose.issuer.yaml"
project="eudi-$role"
public_url="http://localhost:3000"
stored_url=""
stored_workshop=""
https_origin() {
  [[ "$1" =~ ^https://[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?(:[0-9]{1,5})?/?$ ]]
}
if [[ -f "$state_file" ]]; then
  while IFS='=' read -r key value || [[ -n "${key:-}" ]]; do
    [[ -z "$key" ]] && continue
    https_origin "$value" || fail "Ungültige Adresse in $state_file. Die Datei enthält ausschließlich HTTPS-Adressen."
    case "$key" in
      PUBLIC_URL) stored_url="${value%/}" ;;
      WORKSHOP_URL) stored_workshop="${value%/}" ;;
      *) fail "Unbekannter Eintrag in $state_file. Die Datei wird nicht als Shellcode ausgeführt." ;;
    esac
  done < "$state_file"
fi
[[ -z "$stored_url" ]] || public_url="$stored_url"
workshop_url="${workshop_argument:-${WORKSHOP_URL:-$stored_workshop}}"

# Inspection commands never start an app, but Compose still evaluates required variables.
[[ "$operation" == start || -n "$workshop_url" ]] || workshop_url="https://unused.invalid"
compose() {
  PUBLIC_URL="$public_url" WORKSHOP_URL="$workshop_url" docker compose \
    --project-name "$project" --env-file "$root/.env.$role" \
    -f "$base" -f "$root/compose.tunnel.yaml" --profile tunnel "$@"
}

if [[ "$operation" == stop ]]; then
  compose stop app tunnel
  printf 'Gestoppt: %s. Schlüssel und Datenvolumes bleiben erhalten.\n' "$role"
  exit 0
fi
if [[ "$operation" == status ]]; then
  compose ps --all
  if [[ -z "$stored_url" ]]; then
    printf 'Noch keine automatisch ermittelte Adresse gespeichert.\n'
    exit 0
  fi
  printf 'Zuletzt konfigurierte Adresse: %s\n' "$stored_url"
  response="$(curl --fail --silent --show-error --max-time 10 "$stored_url/api/health")" \
    || fail "Der öffentliche $role-Tunnel ist derzeit nicht erreichbar. Starte die Rolle erneut."
  [[ "$response" == "{\"ok\":true,\"role\":\"$role\"}" ]] \
    || fail "Die öffentliche Adresse liefert keinen passenden Demo-Server."
  printf 'Öffentlich erreichbar und passende Rolle geprüft: %s\n' "$role"
  exit 0
fi

if [[ "$role" == issuer ]]; then
  if [[ -z "$workshop_url" ]]; then
    [[ -t 0 ]] || fail "Die Zentrale fehlt. Nutze --workshop-url https://DEINE-ZENTRALE."
    read -r -p 'Öffentliche HTTPS-Adresse der Workshop-Zentrale: ' workshop_url
  fi
  https_origin "$workshop_url" || fail "Die Workshop-Adresse muss ein HTTPS-Origin ohne Pfad, Zugangsdaten oder Query sein."
  workshop_url="${workshop_url%/}"
  response="$(curl --fail --silent --show-error --max-time 10 "$workshop_url/api/health")" \
    || fail "Die Workshop-Zentrale ist nicht erreichbar. Die Moderation muss sie zuerst starten."
  [[ "$response" == '{"ok":true,"role":"workshop"}' ]] \
    || fail "Die angegebene Adresse gehört nicht zu einer Workshop-Zentrale."
fi

new_tunnel=0
temporary=""
cleanup() {
  result=$?
  trap - EXIT INT TERM
  if (( result != 0 && new_tunnel )); then
    printf 'Start fehlgeschlagen: Der neu gestartete Tunnel wird wieder gestoppt.\n' >&2
    compose stop tunnel || printf 'Der Tunnel konnte nicht gestoppt werden. Bitte Docker prüfen.\n' >&2
  fi
  if [[ -n "$temporary" && -f "$temporary" ]]; then rm -- "$temporary"; fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

printf 'Baue und prüfe das Demo-Image für %s …\n' "$role"
compose build app
running="$(compose ps --status running -q tunnel)"
[[ -n "$running" ]] || new_tunnel=1
compose up -d tunnel
tunnel_id="$(compose ps -q tunnel)"
[[ -n "$tunnel_id" && "$tunnel_id" != *$'\n'* ]] || fail "Es wurde nicht genau ein Tunnel-Container gefunden."
tunnel_started="$(docker inspect --format '{{.State.StartedAt}}' "$tunnel_id")"
deadline=$(( SECONDS + timeout ))
candidate=""
while (( SECONDS < deadline )); do
  logs="$(compose logs --no-color --no-log-prefix --since "$tunnel_started" tunnel)"
  if [[ "$(docker inspect --format '{{.State.Running}}' "$tunnel_id")" != true ]]; then
    printf '%s\n' "$logs" >&2
    fail "Der Cloudflared-Prozess wurde beendet, bevor eine nutzbare Adresse bereitstand."
  fi
  while IFS= read -r line; do
    if [[ "$line" =~ https://[a-z0-9-]+\.trycloudflare\.com ]]; then candidate="${BASH_REMATCH[0]}"; fi
  done <<< "$logs"
  [[ -z "$candidate" ]] || break
  sleep 1
done
[[ -n "$candidate" ]] || fail "Cloudflare hat innerhalb von $timeout Sekunden keine Tunnel-Adresse geliefert. Prüfe Internet/Firewall und die Tunnel-Logs."
public_url="$candidate"
if [[ -n "$stored_url" && "$stored_url" != "$public_url" ]]; then
  printf '\nACHTUNG: Die öffentliche Adresse hat sich geändert.\n' >&2
  if [[ "$role" == workshop ]]; then
    printf 'Vorhandene Wallet-Daten bleiben unter der alten Adresse. Hier wäre eine neue Wallet nötig.\n' >&2
  else
    printf 'Issuer neu registrieren und Ausweise mit der neuen Statuslisten-Adresse neu ausstellen.\n' >&2
  fi
fi

umask 077
mkdir -p "$state"
temporary="$state/.$role.env.$$"
{
  printf 'PUBLIC_URL=%s\n' "$public_url"
  [[ "$role" != issuer ]] || printf 'WORKSHOP_URL=%s\n' "$workshop_url"
} > "$temporary"
mv -- "$temporary" "$state_file"
temporary=""
compose up -d --wait --wait-timeout "$timeout" app

printf 'Prüfe den öffentlichen HTTPS-Zugang …\n'
deadline=$(( SECONDS + timeout ))
ready=0
while (( SECONDS < deadline )); do
  if response="$(curl --fail --silent --max-time 10 "$public_url/api/health")"; then
    if [[ "$response" == "{\"ok\":true,\"role\":\"$role\"}" ]]; then ready=1; break; fi
  fi
  sleep 1
done
(( ready )) || fail "Der öffentliche HTTPS-Tunnel erreicht keinen passenden $role-Server. Prüfe die Container-Logs und starte erneut."

app_id="$(compose ps -q app)"
[[ -n "$app_id" && "$app_id" != *$'\n'* ]] || fail "Es wurde nicht genau ein App-Container gefunden."
port="$(docker inspect --format '{{(index (index .NetworkSettings.Ports "3000/tcp") 0).HostPort}}' "$app_id")"
app_started="$(docker inspect --format '{{.State.StartedAt}}' "$app_id")"
logs="$(compose logs --no-color --no-log-prefix --since "$app_started" app)"
admin_link=""
while IFS= read -r line; do
  case "$line" in
    'Verwaltung per Tunnel (privater Freischalt-Link): '*) admin_link="${line#*: }" ;;
  esac
done <<< "$logs"
[[ "$admin_link" == "$public_url/"*'#admin-token='* ]] \
  || fail "Der private Freischalt-Link konnte nicht aus dem aktuellen Serverstart gelesen werden. Bitte die App-Logs prüfen."

new_tunnel=0
printf '\nBereit: %s\nÖffentliche Adresse: %s\n' "$role" "$public_url"
if [[ "$role" == workshop ]]; then
  printf 'Kiosk: %s/kiosk.html\nDiese Zentralen-Adresse an die Teilnehmenden weitergeben: %s\n' "$public_url" "$public_url"
else
  printf 'Issuer lokal: http://localhost:%s/issuer.html\nZentrale: %s\n' "$port" "$workshop_url"
fi
printf '\nNUR FÜR DICH – privater Verwaltungslink, nicht weitergeben:\n%s\n' "$admin_link"
printf '\nDie Sitzung läuft in Docker weiter. Stoppen: bash scripts/demo.sh %s stop\n' "$role"
printf 'Quick-Tunnel-Sitzung: nach Rechner-/Tunnel-Neustart diesen Startbefehl erneut ausführen.\n'
