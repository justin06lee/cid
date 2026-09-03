APP         := cid
APP_BUNDLE  := $(APP).app
BUNDLE_ID   := com.justin06lee.cid
INSTALL_DIR := /Applications
INSTALLED   := $(INSTALL_DIR)/$(APP_BUNDLE)

.PHONY: all build package install update dev clean

# The golden path: everything, in one word.
all: install
	@open -a "$(INSTALLED)"
	@echo "==> $(APP) is running."

node_modules: package.json bun.lock
	bun install
	@# bun blocks lifecycle scripts, and electron's postinstall is what actually
	@# downloads the ~200MB runtime. trustedDependencies covers a clean install;
	@# this covers the case where it was already blocked once.
	@test -d node_modules/electron/dist || node node_modules/electron/install.js
	@touch node_modules

build: node_modules
	bun run build

package: build
	bunx electron-builder --dir
	@# Apple Silicon refuses to launch an unsigned bundle, and there is no
	@# Developer ID here — an ad-hoc signature is enough to run locally.
	@codesign --force --deep --sign - "$$(find release -maxdepth 2 -name '$(APP_BUNDLE)' -print -quit)"

install: package
	@rm -rf "$(INSTALLED)"
	@cp -R "$$(find release -maxdepth 2 -name '$(APP_BUNDLE)' -print -quit)" "$(INSTALL_DIR)/"
	@echo "==> installed to $(INSTALLED)"

# Full refresh of a running install: stop it, remove it, rebuild, reinstall, relaunch.
update:
	-@osascript -e 'quit app "$(APP)"' 2>/dev/null || true
	-@pkill -f "$(INSTALLED)" 2>/dev/null || true
	@rm -rf "$(INSTALLED)"
	@$(MAKE) all

dev: node_modules
	bun run dev

clean:
	rm -rf out release
