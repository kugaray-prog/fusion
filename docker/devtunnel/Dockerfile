# Dev Tunnels CLI -- hosts the HTTPS tunnel (MOBILE_API_BASE_URL in .env) that
# the phone app needs for Google Sign-In, so VS Code port forwarding isn't.
# gnome-keyring + dbus give the CLI somewhere to keep its login token; without
# a keyring it only holds the token in memory and forgets it on exit.
FROM mcr.microsoft.com/dotnet/runtime-deps:8.0
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates dbus-x11 gnome-keyring libsecret-1-0 \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL https://aka.ms/TunnelsCliDownload/linux-x64 -o /usr/local/bin/devtunnel \
 && chmod +x /usr/local/bin/devtunnel
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
