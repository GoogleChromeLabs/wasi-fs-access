import subprocess
import sys
from pathlib import Path
import platform

tests_dir = Path(__file__).parent

args = sys.argv[1:]
envs = []

if "--version" not in args:
    test_file_index = args.index("--test-file") + 1
    test_file_path = Path(args[test_file_index])
    if "rust" in test_file_path.parts:
        # Not supported.
        envs.append("NO_FD_ALLOCATE")
        if platform.system() == "Windows":
            envs.append("NO_RENAME_DIR_TO_EMPTY_DIR")

r = subprocess.run(
    [
        "node",
        "--stack-trace-limit=1000",
        "--enable-source-maps",
        "--experimental-wasm-jspi",
        "--import",
        "tsx",
        tests_dir / "test-adapter.ts",
        *args,
        *(f"--env={env}=1" for env in envs)
    ]
).returncode

if r:
    # If the test fails, it keeps garbage around which results in different failures for subsequent tests. Clean it up.
    subprocess.run(
        ["git", "-C", tests_dir / "wasi-testsuite", "clean", "-dfx"], check=True
    )

exit(r)
