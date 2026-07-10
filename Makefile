UUID = gnomepong@vanvonvan.github.io
EXT_SRC = $(UUID)
EXT_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SCHEMA_DIR = $(EXT_SRC)/schemas

.PHONY: all schemas install link uninstall pack nested devkit test assets

all: schemas

# Run the headless logic tests (no shell needed).
test:
	gjs -m tests/engine-smoke.js
	gjs -m tests/render-smoke.js
	gjs -m tests/net-smoke.js
	gjs -m tests/netgame-smoke.js

# Play the game in a standalone GTK4 window (reuses the real engine/renderer).
preview: schemas
	gjs -m tools/preview.js

# Compile the GSettings schema in place (needed for both dev and packing).
schemas:
	glib-compile-schemas $(SCHEMA_DIR)

# Regenerate the repo art (icon/logo/banner) and screenshots. Both reuse the
# game's own renderer/visual language so the branding matches the product.
assets: schemas
	python3 tools/gen_art.py
	gjs -m tools/gen_screens.js

# Symlink the extension source into the extensions dir for live development.
link: schemas
	mkdir -p $(HOME)/.local/share/gnome-shell/extensions
	rm -rf $(EXT_DIR)
	ln -sfn $(CURDIR)/$(EXT_SRC) $(EXT_DIR)
	@echo "Linked $(CURDIR)/$(EXT_SRC) -> $(EXT_DIR)"

# Copy (not link) an installed build.
install: schemas
	mkdir -p $(EXT_DIR)
	cp -r $(EXT_SRC)/metadata.json $(EXT_SRC)/extension.js $(EXT_SRC)/prefs.js \
		$(EXT_SRC)/stylesheet.css $(EXT_SRC)/lib $(EXT_SRC)/sounds $(EXT_SRC)/schemas \
		$(EXT_SRC)/icons $(EXT_DIR)/
	@echo "Installed to $(EXT_DIR)"

uninstall:
	rm -rf $(EXT_DIR)

# Build a distributable zip.
pack: schemas
	gnome-extensions pack --force \
		--extra-source=lib \
		--extra-source=sounds \
		--extra-source=icons \
		$(EXT_SRC)

# Launch a nested GNOME Shell with the extension enabled (isolated config).
# NOTE: on this NVIDIA box a plain `--wayland` shell dies with EBUSY, so this
# rarely opens a visible window here — prefer `make devkit` below.
nested: link
	bash tools/run-nested.sh

# Launch a VISIBLE, isolated nested GNOME Shell via the devkit backend with
# GnomePong enabled. This is the ONE way that actually renders + accepts input
# on this box (the devkit's mutter-devkit backend works where `--wayland` hits
# EBUSY). This is the way to play-test on Wayland without logging out.
devkit: link
	bash tools/run-devkit.sh
