import subprocess
import sys
from pathlib import Path
import platform

tests_dir = Path(__file__).parent

envs = []

match platform.system():
    case "Darwin":
        envs.append("ERRNO_MODE_MACOS")
    case "Linux":
        envs.append("ERRNO_MODE_UNIX")
    case "Windows":
        envs.append("ERRNO_MODE_WINDOWS")
        envs.append("NO_RENAME_DIR_TO_EMPTY_DIR")

# Not supported.
envs.append("NO_FD_ALLOCATE")

try:
    subprocess.run(
        [
            "node",
            "--experimental-wasm-jspi",
            "--import",
            "tsx",
            tests_dir / "test-adapter.ts",
            *sys.argv[1:],
            *(f"--env={env}=1" for env in envs)
        ],
        check=True,
    )
except:
    # If the test fails, it keeps garbage around which results in different failures for subsequent tests. Clean it up.
    subprocess.run(
        ["git", "-C", tests_dir / "wasi-testsuite", "clean", "-dfx"], check=True
    )
    raise
