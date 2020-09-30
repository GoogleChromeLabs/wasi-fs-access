# Asyncify

This is a JavaScript wrapper intended to be used with Asyncify feature of Binaryen.

Together, they allow to use asynchronous APIs (such as most Web APIs) from within WebAssembly written and compiled from any source language.

## Usage

### WebAssembly side

Import and use required APIs as regular synchronous FFI functions in your code.

After the code is compiled to WebAssembly, post-process it using `wasm-opt` from the [Binaryen toolchain](https://github.com/WebAssembly/binaryen):

```shell
wasm-opt --asyncify [-O] [--pass-arg=asyncify-imports@module1.func1,...] in.wasm -o out.wasm
```

### JavaScript side

First, import asyncify via:

```javascript
import * as Asyncify from 'https://unpkg.com/asyncify-wasm?module';
```

Compilation / instantiation APIs are designed to be drop-in replacements for those of regular `WebAssembly` interface, but with `async` support.

Then, you can use `new Asyncify.Instance`, `Asyncify.instantiate` and `Asyncify.instantiateStreaming` like you would with corresponding `WebAssembly` functions, but with added support for `async` imports and all exports wrapped into async functions, too.

For example:

```js
let { instance } = await Asyncify.instantiateStreaming(fetch('./out.wasm'), {
  get_resource_text: async url => {
    let response = await fetch(readWasmString(instance, url));
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return passStringToWasm(instance, await response.text());
  }
});

await instance.exports._start();
```
