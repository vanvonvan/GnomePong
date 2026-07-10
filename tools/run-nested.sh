#!/usr/bin/env bash
# Launch a visible, isolated nested GNOME Shell with GnomePong enabled, so you
# can play-test without touching your live session's settings.
#
# GNOME 50 dropped the old `--nested` flag: a plain `--wayland` compositor runs
# nested inside your current session. We keep dconf isolated via a throwaway
# XDG_CONFIG_HOME so enabling the extension (and any color changes you make)
# never clobber your real configuration.
set -euo pipefail

UUID="gnomepong@vanvonvan.github.io"
ISO="$(mktemp -d)"
trap 'rm -rf "$ISO"' EXIT

echo "Nested GNOME Shell — GnomePong enabled, isolated config at $ISO"
echo "Close the nested window (or Ctrl+C here) to quit."

XDG_CONFIG_HOME="$ISO" dbus-run-session -- bash -c "
  gsettings set org.gnome.shell disable-user-extensions false
  gsettings set org.gnome.shell enabled-extensions \"['$UUID']\"
  exec gnome-shell --wayland --wayland-display=gnomepong-test
"