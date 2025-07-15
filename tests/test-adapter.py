import subprocess
import sys
import os

script_dir = os.path.dirname(os.path.abspath(__file__))
script_path = os.path.join(script_dir, "test-adapter.ts")
r = subprocess.run(["node", "--experimental-wasm-jspi", "--import", "tsx", script_path, *sys.argv[1:]])
sys.exit(r.returncode)
