#!/usr/bin/env bash
# Launch a VISIBLE, isolated nested GNOME Shell via the devkit backend, with
# GnomePong enabled, so you can actually play-test on this box.
#
# Why the devkit and not `gnome-shell --wayland`: on this machine (NVIDIA,
# mutter 50.1) a plain `--wayland` compositor tries to become a native display
# server and dies with `EBUSY: Failed to take control of the session`. The
# devkit backend (`mutter-devkit`) instead renders into a nested virtual
# monitor using EGL/GBM on the GPU — it works here where `--wayland` cannot.
#
# Two things make it usable for OUR extension:
#   1. `dbus-run-session` gives it its own session bus, so it doesn't collide
#      with the live shell (`org.gnome.Shell already exists on bus`).
#   2. an isolated XDG_CONFIG_HOME keeps dconf changes (enabling the extension,
#      any color tweaks) out of your real configuration.
# The extension itself is found via ~/.local/share (XDG_DATA_HOME, unchanged),
# so the existing `make link` symlink is what gets loaded.
set -euo pipefail

UUID="gnomepong@vanvonvan.github.io"
ISO="$(mktemp -d)"
MARKER="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/gnome-shell-disable-extensions"

# The devkit drops a global "disable extensions" marker in the (shared) runtime
# dir. Our nested shell still loads GnomePong, but tidy it up on exit so a later
# freshly-started shell isn't left with extensions disabled.
cleanup() { rm -rf "$ISO"; rm -f "$MARKER"; }
trap cleanup EXIT

echo "Devkit GNOME Shell — GnomePong enabled, isolated config at $ISO"
echo "Close the nested window (or Ctrl+C here) to quit."

XDG_CONFIG_HOME="$ISO" dbus-run-session -- bash -c "
  gsettings set org.gnome.shell disable-user-extensions false
  gsettings set org.gnome.shell enabled-extensions \"['$UUID']\"
  exec gnome-shell --devkit
"
