# wasi-fs-access

This is a demo shell powered by [WebAssembly](https://webassembly.org/), [WASI](https://wasi.dev/), [Asyncify](https://github.com/GoogleChromeLabs/asyncify) and [File System Access API](https://wicg.github.io/file-system-access/).

It provides WASI bindings implementation that proxies any filesystem requests to a real, host filesystem. This allows apps built in languages like C, C++, Rust and others to be compiled to WebAssembly and work as usual within a browser sandbox, accessing and manipulating files in a "real world".

A [Rust port of coreutils with some patches](https://github.com/RReverser/coreutils) was chosen for the demo purposes, but it should be possible to extract and reuse same bindings for any applications compiled for the WASI target.

Check out the demo here: https://googlechromelabs.github.io/wasi-fs-access/.
