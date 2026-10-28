# syntax=docker/dockerfile:1

# GeoAttend mobile -- Expo dev server for Expo Go (`npm run go`).
#
# Runs Metro inside the container and prints the Expo QR code in the
# container's log. The phone scans it with Expo Go and loads the JS bundle
# from this PC, so the QR must advertise the PC's Wi-Fi IP, not the
# container's internal 172.x address -- docker-compose.yml passes that in as
# REACT_NATIVE_PACKAGER_HOSTNAME.
#
# Node 22: react-native 0.86 needs ^20.19.4 || ^22.13.0, and node:20 tags
# can lag behind 20.19.

FROM node:22-bookworm-slim
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# 8081 = Metro bundler (what the QR code points at).
EXPOSE 8081

# poll-watch.js re-raises edits saved from Windows so Metro sees them and
# Expo Go reloads by itself (Docker doesn't pass those file events through).
CMD ["sh", "-c", "node docker/poll-watch.js & exec npm run go"]
