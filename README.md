# dispensable-ask

`dispensable-ask` is a Pi extension that exposes the model-visible
`dispensable_ask` tool only when you want it. It is designed for local models
that sometimes reconsider the same decision instead of asking for the missing
input.

## Behavior

- Starts **disabled** in every session.
- Press `Alt+A` to expose or hide `dispensable_ask`.
- The shortcut remains available while Pi is streaming an answer or thinking.
- An in-flight model request may already have received the tool schema; when
  you disable it, the extension also blocks any stale tool call from that
  request.
- Questions time out after 30 seconds by default.
- A timeout disables the tool for the rest of that session. Only you can
  re-enable it.
- Escape cancels the current question without changing the enabled state.
- The timeout is global and persists across sessions; the enabled state does
  not persist.
- While a question is open, the exposure toggle is intentionally inactive.

The question UI supports single choice, multiple choice, searchable options,
free-form answers, context, optional comments, and overlay or inline display.

## Install

Install the local package globally in Pi:

```sh
pi install /Users/donais/Documents/Projects/dispensable-ask
```

Restart Pi after installation. Use `pi config` if you later want to disable or
remove the package resource itself.

For a one-off test:

```sh
pi -e /Users/donais/Documents/Projects/dispensable-ask
```

## Controls

| Action | Control |
| --- | --- |
| Toggle exposure | `Alt+A` |
| Show current state | `/dispensable-ask` |
| Enable | `/dispensable-ask on` |
| Disable | `/dispensable-ask off` |
| Toggle | `/dispensable-ask toggle` |
| Set global timeout | `/dispensable-ask timeout 45s` |

Timeout values may be plain seconds (`30`), seconds with a suffix (`45s`),
milliseconds (`1500ms`), or minutes (`2m`). The accepted range is 1 second to
24 hours.

## macOS keyboard name

On macOS, **Alt is the Option key**, so the default shortcut is **Option+A**
(`⌥A`). Pi and its documentation use the cross-platform name `Alt+A`.

## Global configuration

The command writes the timeout to:

```text
~/.pi/agent/dispensable-ask.json
```

Default contents:

```json
{
  "timeoutSeconds": 30,
  "shortcut": "alt+a"
}
```

You may edit `shortcut` manually. Restart Pi after changing it because
extension shortcuts are registered at startup. Invalid values fall back to
`alt+a`.

Optional UI preferences can be set in the environment:

```sh
export DISPENSABLE_ASK_DISPLAY_MODE=inline
export DISPENSABLE_ASK_SINGLE_SELECT_LAYOUT=list
export DISPENSABLE_ASK_ALLOW_COMMENT=true
export DISPENSABLE_ASK_OVERLAY_TOGGLE_KEY=alt+o
export DISPENSABLE_ASK_COMMENT_TOGGLE_KEY=ctrl+g
```

## Development

```sh
npm install
npm run check
```

The interactive UI is adapted from
[`pi-ask-user`](https://github.com/edlsh/pi-ask-user) 0.14.0 under the MIT
License. See `NOTICE` and `LICENSE`.
