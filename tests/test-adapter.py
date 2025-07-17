import subprocess
import sys
from pathlib import Path

tests_dir = Path(__file__).parent

try:
	subprocess.run(["node", "--experimental-wasm-jspi", "--import", "tsx", tests_dir / "test-adapter.ts", *sys.argv[1:], "--env", "NO_FD_ALLOCATE=1"], check=True)
except:
	# If the test fails, it keeps garbage around which results in different failures for subsequent tests. Clean it up.
	subprocess.run(["git", "-C", tests_dir / "wasi-testsuite", "clean", "-df"], check=True)
	raise
