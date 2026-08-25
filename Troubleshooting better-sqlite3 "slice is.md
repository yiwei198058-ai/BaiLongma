Troubleshooting better-sqlite3 "slice is not valid mach-o file" on macOS

Commands to try (run in project root):

- Remove existing native modules and reinstall:
	rm -rf node_modules package-lock.json
	npm install

- If error persists, rebuild better-sqlite3 from source:
	npm rebuild better-sqlite3 --build-from-source

- Or force full reinstall with build from source:
	npm install --build-from-source=better-sqlite3

- On Apple Silicon (M1/M2) you may need to set architecture for node-gyp:
	export npm_config_arch=arm64
	npm rebuild better-sqlite3 --build-from-source

- If using Rosetta (x86) Node, run terminal under Rosetta or install x64 Node and rebuild.

- As a last resort, remove prebuilt binary and reinstall:
	rm -f node_modules/better-sqlite3/build/Release/better_sqlite3.node
	npm install --build-from-source=better-sqlite3

Also ensure Xcode command line tools are installed:
	xcode-select --install

These steps fix mismatched Mach-O slice issues caused by prebuilt native binaries for a different CPU architecture.
