# wasi-fs-access

This is a demo shell powered by [WebAssembly](https://webassembly.org/), [WASI](https://wasi.dev/), [Asyncify](https://emscripten.org/docs/porting/asyncify.html) and [File System Access API](https://wicg.github.io/file-system-access/).

It provides WASI bindings implementation that proxies any filesystem requests to a real, host filesystem. This allows apps built in languages like C, C++, Rust and others to be compiled to WebAssembly and work as usual within a browser sandbox, accessing and manipulating files in a "real world".

Since WASI APIs are synchronous by nature, but Web APIs are traditionally asynchronous to avoid blocking the main thread, Asyncify is used to bridge the two types of APIs together. Asyncify is a feature created as part of [Emscripten](https://emscripten.org/) and later extended to work with arbitrary WebAssembly files with the help of a [custom JavaScript wrapper](https://github.com/GoogleChromeLabs/asyncify).

A [Rust port of coreutils with some patches](https://github.com/RReverser/coreutils) was chosen for the demo purposes, but it should be possible to extract and reuse same bindings for any applications compiled for the WebAssembly + WASI target.

Check out the demo here: https://googlechromelabs.github.io/wasi-fs-access/.
