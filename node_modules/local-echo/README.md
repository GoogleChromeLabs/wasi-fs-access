# 📢 local-echo [![Travis (.org)](https://img.shields.io/travis/wavesoft/local-echo.svg)](https://travis-ci.org/wavesoft/local-echo) [![Try it in codepen.io](https://img.shields.io/badge/Try%20it-codepen.io-blue.svg)](https://codepen.io/anon/pen/qMYjGZ?editors=0010)


> A fully functional local echo controller for xterm.js

You will be surprised how difficult it is to implement a fully functional local-echo controller for [xterm.js](https://github.com/xtermjs/xterm.js) (or any other terminal emulator). This project takes this burden off your hands.

### Features

The local echo controller tries to replicate most of the bash-like user experience primitives, such as:

- _Arrow navigation_: Use `left` and `right` arrows to navigate in your input
- _Word-boundary navigation_: Use `alt+left` and `alt+right` to jump between words
- _Word-boundary deletion_: Use `alt+backspace` to delete a word
- _Multi-line continuation_: Break command to multiple lines if they contain incomplete quotation marks, boolean operators (`&&` or `||`), pipe operator (`|`), or new-line escape sequence (`\`).
- _Full-navigation on multi-line command_: You are not limited only on the line you are editing, you can navigate and edit all of your lines.
- _Local History_: Just like bash, access the commands you previously typed using the `up` and `down` arrows.
- _Tab-Completion_: Provides support for registering your own tab-completion callbacks.

## Usage

### As ES6 Module

1. Install it using `npm`:

    ```sh
    npm install --save wavesoft/local-echo
    ```

    Or yarn:

    ```sh
    yarn add wavesoft/local-echo
    ```

2. Use it like so:

    ```js
    import { Terminal } from 'xterm';
    import LocalEchoController from 'local-echo';

    // Start an xterm.js instance
    const term = new Terminal();
    term.open(document.getElementById('terminal'));

    // Create a local echo controller (xterm.js v3)
    const localEcho = new LocalEchoController(term);
    // Create a local echo controller (xterm.js >=v4)
    const localEcho = new LocalEchoController();
    term.loadAddon(localEcho);

    // Read a single line from the user
    localEcho.read("~$ ")
        .then(input => alert(`User entered: ${input}`))
        .catch(error => alert(`Error reading: ${error}`));
    ```

### Directly in the browser

1. Download `local-echo.js` from the latest [release](/wavesoft/local-echo/releases)
2. Include it in your HTML:

    ```
    <script src="/js/local-echo.js"></script>
    ```

3. Use it like so:

    ```js
    // Start an xterm.js instance
    const term = new Terminal();
    term.open(document.getElementById('terminal'));

    // Create a local echo controller (xterm.js v3)
    const localEcho = new LocalEchoController(term);
    // Create a local echo controller (xterm.js >=v4)
    const localEcho = new LocalEchoController();
    term.loadAddon(localEcho);

    // Read a single line from the user
    localEcho.read("~$ ")
        .then(input => alert(`User entered: ${input}`))
        .catch(error => alert(`Error reading: ${error}`));
    ```

## API Reference

### `constructor(term, [options])`

The constructor accepts an `xterm.js` instance as the first argument and an object with possible options. The options can be:

```js
{
    // The maximum number of entries to keep in history
    historySize: 10,
    // The maximum number of auto-complete entries, after which the user
    // will have to confirm before the entries are displayed.
    maxAutocompleteEntries: 100
}
```

### `.read(prompt, [continuationPrompt])` -> Promise

Reads a single line from the user, using local-echo. Returns a promise that will be resolved with the user input when completed.

```js
localEcho.read("~$", "> ")
        .then(input => alert(`User entered: ${input}`))
        .catch(error => alert(`Error reading: ${error}`));
```

### `.readChar(prompt)` -> Promise

Reads a single character from the user, without echoing anything. Returns a promise that will be resolved with the user input when completed.

This input can be active in parallel with a `.read` prompt. A character typed will be handled in priority by this function.

This is particularly helpful if you want to prompt the user for something amidst an input operation. For example, prompting to confirm an expansion of a large number of auto-complete candidates during tab completion.

```js
localEcho.readChar("Display all 1000 possibilities? (y or n)")
        .then(yn => {
            if (yn === 'y' || yn === 'Y') {
                localEcho.print("lots of stuff!");
            }
        })
        .catch(error => alert(`Error reading: ${error}`));
```

### `.abortRead([reason])`

Aborts a currently active `.read`. This function will reject the promise returned from `.read`, passing the `reason` as the rejection reason.

```js
localEcho.read("~$", "> ")
        .then(input => {})
        .catch(error => alert(`Error reading: ${error}`));

localEcho.abortRead("aborted because the server responded");
```

### `.print([message])`
### `.println([message])`

Print a message (and change line) to the terminal. These functions are tailored for writing plain-text messages, performing the appropriate conversions.

For example all new-lines are normalized to `\r\n`, in order for them to appear correctly on the terminal.

### `.printWide(strings)`

Prints an array of strings, occupying the full terminal width. For example:

```js
localEcho.printWide(["first", "second", "third", "fourth", "fifth", "sixth"]);
```

Will display the following, according to the current width of your terminal:

```
first  second  third  fourth
fifth  sixth
```

### `.addAutocompleteHandler(callback, [args...])`

Registers an auto-complete handler that will be used by the local-echo controller when the user hits `TAB`.

The callback has the following signature:

```js
function (index: Number, tokens: Array[String], [args ...]): Array[String] 
```

Where:

* `index`: represents the current token in the user command that an auto-complete is requested for.
* `tokens` : an array with all the tokens in the user command
* `args...` : one or more arguments, as given when the callback was registered.

The function should return an array of possible auto-complete expressions for the current state of the user input.

For example:

```js
// Auto-completes common commands
function autocompleteCommonCommands(index, tokens) {
    if (index == 0) return ["cp", "mv", "ls", "chown"];
    return [];
}

// Auto-completes known files
function autocompleteCommonFiles(index, tokens) {
    if (index == 0) return [];
    return [ ".git", ".gitignore", "package.json" ];
}

// Register the handlers
localEcho.addAutocompleteHandler(autocompleteCommonCommands);
localEcho.addAutocompleteHandler(autocompleteCommonFiles);
```
