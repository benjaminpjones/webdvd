.PHONY: dev test wasm disc clean

VIDEO_TS ?= /tmp/webdvd-test/VIDEO_TS

# Start both servers for local development
dev:
	@if [ ! -d "$(VIDEO_TS)" ]; then \
		echo "Error: VIDEO_TS not found: $(VIDEO_TS)"; \
		echo "Usage: make dev VIDEO_TS=/path/to/VIDEO_TS"; \
		echo "   or: make disc   (generate test disc first)"; \
		exit 1; \
	fi
	@trap 'kill 0' EXIT; \
	(cd server && cargo run -- "$(VIDEO_TS)") & \
	(cd player && npx vite) & \
	wait

# Run all tests (WASM smoke + e2e)
test:
	node wasm/test.mjs
	cd player && npm test

# Build WASM module (requires emcc on PATH)
wasm:
	./wasm/build.sh

# Generate test disc (requires ffmpeg + dvdauthor + spumux)
disc:
	./scripts/make-test-disc.sh

# Install player dependencies
install:
	cd player && npm install

# Clean build artifacts
clean:
	rm -rf wasm/build
	cd server && cargo clean
	rm -rf player/node_modules/.vite
