#!/bin/sh
# Hosts DEVTUNNEL_ID (e.g. "pq2qwb2x.asse", from MOBILE_API_BASE_URL) and
# forwards it to port 3000 of the app container. Needs a one-time login:
#   docker compose run --rm tunnel login
set -e

# Unlock a keyring (kept in the /root volume) so the login token survives.
# The daemons' output goes to files, not $(...): they keep stdout open, so a
# command substitution would wait on them forever.
dbus-launch --sh-syntax > /tmp/dbus.env
. /tmp/dbus.env
export DBUS_SESSION_BUS_ADDRESS
mkdir -p /root/.local/share/keyrings
printf 'devtunnel' | gnome-keyring-daemon --unlock --components=secrets > /tmp/keyring.env 2>/dev/null
. /tmp/keyring.env
export GNOME_KEYRING_CONTROL

case "$1" in
  login) exec devtunnel user login -g -d ;;
  "") ;;
  *) exec devtunnel "$@" ;;
esac

if devtunnel user show 2>&1 | grep -q "Logged in"; then
  # 30 days is the longest a tunnel may live, so restart the countdown on
  # every start -- it never expires as long as this container runs now and then.
  # The daily loop covers a container left running for more than 30 days.
  ( while :; do
      devtunnel update "$DEVTUNNEL_ID" --expiration 30d >/dev/null 2>&1 \
        || echo "Dev Tunnels: could not renew the 30-day expiration (will retry)."
      sleep 86400
    done ) &
  exec devtunnel host "$DEVTUNNEL_ID"
fi
echo "Dev Tunnels: not logged in. Run: docker compose run --rm tunnel login"
sleep 60
exit 1
