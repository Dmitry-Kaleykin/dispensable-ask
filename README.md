# dispensable-ask

`dispensable-ask` is a Pi extension that provides the model-visible
`ask_user` tool with an optional inactivity timer. It is designed for local
models that sometimes reconsider the same decision instead of asking for the
missing input.

## Behavior

- The tool is always available; the **timer starts disabled** in every session.
- Press `Alt+A` to enable or disable the timer.
- With the timer disabled, questions wait indefinitely for your answer.
- With the timer enabled, questions time out after 30 seconds of inactivity
  by default, allowing the model to continue without your answer.
- The shortcut remains available while Pi is streaming an answer or thinking.
- While a timed question is open, its box header and the status widget show the
  remaining idle time. It jumps back to the configured limit whenever you
  interact. Otherwise, the widget shows only `❓ ask timer:on` or
  `❓ ask timer:off`.
- The status is painted in the theme's accent colour, like the `🔌 MCP: …`
  and `🔒 Sandbox: …` statuses next to it. Pi prints footer status text
  verbatim, so the extension applies the colour itself.
- Typing, navigating options, toggling a choice, or interacting with the prompt
  restarts an enabled idle timer. If you stop midway, a fresh 30-second window
  begins after your last action.
- A timeout leaves the tool available and the timer enabled for future questions.
- Escape cancels the current question without changing the timer state.
- The timeout duration is global and persists across sessions; the timer's
  enabled state does not persist.
- While a question is open, the timer toggle is intentionally inactive.
- On macOS with Apple Terminal, a question brings the tab running Pi and its
  window to the foreground before any idle timer starts.

The question UI supports single choice, multiple choice, searchable options,
free-form answers, context, optional comments, and overlay or inline display.

The package and its controls are named `dispensable-ask`. Only the tool exposed
to the model is named `ask_user`.

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
| Toggle timer | `Alt+A` |
| Show current state | `/dispensable-ask` |
| Enable timer | `/dispensable-ask on` |
| Disable timer (wait indefinitely) | `/dispensable-ask off` |
| Toggle timer | `/dispensable-ask toggle` |
| Set global timeout | `/dispensable-ask timeout 45s` |

Timeout values may be plain seconds (`30`), seconds with a suffix (`45s`),
milliseconds (`1500ms`), or minutes (`2m`). The accepted range is 1 second to
24 hours.

Long option titles and descriptions wrap to the available width. When the
highlighted option is taller than its pane, use `←` / `→` to scroll up/down
through it, or `Shift+PgUp` / `Shift+PgDn` to scroll by a page. This works in
single-choice lists, the split preview, and multiple-choice lists. An overflow
hint shows your position; moving to another option starts at the top. Plain
`↑` / `↓` still changes options, and `PgUp` / `PgDn` scrolls the question/context.
`Shift+↑` / `Shift+↓` also works when the terminal preserves the Shift modifier;
use `←` / `→` if those combinations move between options instead.

## macOS keyboard name

On macOS, **Alt is the Option key**, so the default shortcut is **Option+A**
(`⌥A`). Pi and its documentation use the cross-platform name `Alt+A`.

## Bring Terminal forward on a question

In local interactive Pi sessions running in Apple Terminal on macOS, opening
`ask_user` selects the tab running Pi, restores its window if minimized, and
brings it forward. This happens once per question, before the idle countdown.
It does not keep the window permanently on top.

To switch to the desktop containing that window, enable **System Settings →
Desktop & Dock → Mission Control → When switching to an application, switch
to a Space with open windows for the application**. The extension does not
change this system preference.

macOS may request Automation permission to control Terminal on first use.
Activation is best effort and bounded to four seconds; if permission is denied
or the tab cannot be found, the question still opens normally. SSH, tmux,
screen, other terminal apps, and non-TUI sessions skip activation.

To disable this behavior, set the following before starting Pi:

```sh
export DISPENSABLE_ASK_FOCUS_TERMINAL=false
```

The model cannot override this preference.

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

These presentation settings are global user configuration. They are not
included in the `ask_user` schema and cannot be chosen or overridden by the
model.

## Development

```sh
npm install
npm run check
```

### Architecture

The package uses a feature-oriented extension layout. Dependencies point
inward from Pi integration toward the `ask-user` feature and its UI:

```text
index.ts                              package entry point
src/
├── extension/
│   ├── register-dispensable-ask.ts   composition root
│   ├── ask-timer.ts                  session-local timer state
│   ├── status.ts                     footer status text and accent colour
│   └── register-controls.ts          shortcut, command, session lifecycle
├── ask-user/
│   ├── constants.ts                  model-visible tool identity
│   ├── idle-timeout.ts               restartable inactivity timer
│   ├── terminal-focus.ts             macOS Terminal tab activation
│   ├── register-tool.ts              Pi tool schema and execution
│   ├── dialogs.ts                    RPC/headless fallback
│   ├── model.ts                      inputs, results, normalization
│   └── ui/
│       ├── ask-component.ts          question-flow container
│       ├── multi-select-list.ts      multi-choice interaction
│       ├── single-select-list.ts     searchable single-choice interaction
│       ├── single-select-layout.ts   layout calculation
│       └── shared.ts                 shared TUI primitives and shortcuts
├── config/config.ts                  persistent global preferences
└── version.ts                        package-version lookup
```

`extension/` owns Pi lifecycle policy, while `ask-user/` owns the feature.
The UI does not manage timer settings or persistence, and configuration does not
depend on the TUI.

The interactive UI is adapted from
[`pi-ask-user`](https://github.com/edlsh/pi-ask-user) 0.14.0 under the MIT
License. See `NOTICE` and `LICENSE`.
