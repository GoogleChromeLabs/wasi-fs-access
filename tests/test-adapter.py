import subprocess
import sys
from pathlib import Path
import platform

tests_dir = Path(__file__).parent

args = sys.argv[1:]

match platform.system():
	case "Darwin":
		errno_mode = "ERRNO_MODE_MACOS"
	case "Linux":
		errno_mode = "ERRNO_MODE_UNIX"
	case "Windows":
		errno_mode = "ERRNO_MODE_WINDOWS"

if errno_mode is not None:
	args.append(f"--env={errno_mode}=1")

# Not supported yet.
args.append("--env=NO_FD_ALLOCATE=1")

try:
	subprocess.run(["node", "--experimental-wasm-jspi", "--import", "tsx", tests_dir / "test-adapter.ts", *args], check=True)
except:
	# If the test fails, it keeps garbage around which results in different failures for subsequent tests. Clean it up.
	subprocess.run(["git", "-C", tests_dir / "wasi-testsuite", "clean", "-dfx"], check=True)
	raise
