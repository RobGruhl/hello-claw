PACKAGE_NAME := hello-claw-bootstrap
STAGING_DIR  := .package-staging
ZIP_FILE     := $(PACKAGE_NAME).zip
MINI         ?= $(shell hostname -s)

# App files to include in the package (no node_modules, dist, data, workspace)
APP_FILES := package.json package-lock.json tsconfig.json src plugins workspace-seed constitution .env.example

.PHONY: package snapshot clean

## package: Build hello-claw-bootstrap.zip
package:
	@echo "==> Building $(ZIP_FILE)"
	@rm -rf $(STAGING_DIR) $(ZIP_FILE)
	@mkdir -p $(STAGING_DIR)/hello-claw/app
	@# Bootstrap scripts
	@cp bootstrap/setup.sh bootstrap/run.sh bootstrap/com.hello-claw.agent.plist $(STAGING_DIR)/hello-claw/
	@chmod +x $(STAGING_DIR)/hello-claw/setup.sh $(STAGING_DIR)/hello-claw/run.sh
	@# App source
	@for f in $(APP_FILES); do \
		if [ -e "$$f" ]; then cp -R "$$f" $(STAGING_DIR)/hello-claw/app/; fi; \
	done
	@# Zip
	@cd $(STAGING_DIR) && zip -rq ../$(ZIP_FILE) hello-claw/
	@rm -rf $(STAGING_DIR)
	@echo "  ✓ $(ZIP_FILE) ($$(du -h $(ZIP_FILE) | cut -f1))"

## snapshot: Capture volatile state from a live Mini
##   Local:  make snapshot
##   Remote: make snapshot MINI=testhost.local
snapshot:
	@echo "==> Capturing state from $(MINI)"
	@STAMP=$$(date +%Y%m%d-%H%M%S); \
	if [ "$(MINI)" = "$$(hostname -s)" ]; then \
		cd $$HOME/hello-claw && tar czf /tmp/hello-claw-state-$$STAMP.tar.gz \
			app/data app/workspace .env 2>/dev/null; \
		mv /tmp/hello-claw-state-$$STAMP.tar.gz .; \
		echo "  ✓ $$HOME/hello-claw/hello-claw-state-$$STAMP.tar.gz"; \
	else \
		ssh $(MINI) "cd ~/hello-claw && tar czf /tmp/hello-claw-state-$$STAMP.tar.gz \
			app/data app/workspace .env 2>/dev/null"; \
		scp $(MINI):/tmp/hello-claw-state-$$STAMP.tar.gz .; \
		ssh $(MINI) "rm /tmp/hello-claw-state-$$STAMP.tar.gz"; \
		echo "  ✓ hello-claw-state-$$STAMP.tar.gz"; \
	fi

## clean: Remove build artifacts
clean:
	rm -rf $(STAGING_DIR) $(ZIP_FILE) hello-claw-state-*.tar.gz
