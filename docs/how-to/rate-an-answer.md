# How to rate an answer, a feature or a session

This guide records a rating on this machine: `up` when something worked, `meh` when it worked without impressing you, `down` when it did not work. Only a person can rate; there is no MCP tool for it, so an agent cannot. Run the commands from inside the repository; `gsd-atlas` below stands for `node /path/to/gsd-atlas/dist/bin/gsd-atlas.js`.

1. Ask the question first. The newest answer of the repository is the one that gets rated:

   ```sh
   gsd-atlas find <name>
   ```

2. Rate it with one of `up`, `meh` or `down`:

   ```sh
   gsd-atlas rate up
   ```

   `rate up --last` does the same, because the newest answer is the default. The result is a JSON envelope on stdout, and stderr confirms it:

   ```text
   gsd-atlas: recorded "up" for the last answer
   ```

3. To rate a feature rather than one answer, name it with `--feature`. The names it accepts are listed in [the CLI reference](../reference/cli.md#gsd-atlas-rate):

   ```sh
   gsd-atlas rate meh --feature code_find
   ```

   stderr says `gsd-atlas: recorded "meh" for feature "code_find"`.

4. To rate the session, use `--session`:

   ```sh
   gsd-atlas rate down --session
   ```

   stderr says `gsd-atlas: recorded "down" for the session`.

A rating is one row in `metrics.db`, in the store folder of the repository: the time, the scope, the value, and the id of the answer, the feature name or the session id. It holds no text, not the answer's content, and nothing is sent anywhere.

## If there is no answer to rate

`rate` stops with `no_recent_answer` and exit 2: the repository has no recorded answer yet. Ask a question, then rate. The message also suggests naming an answer by its answer id, but `rate` takes no such option; use `--feature` or `--session` to rate something else.

## If the feature name is not accepted

The command prints `gsd-atlas: --feature must be one of` followed by the accepted names, and exits 1. Use one of those names.

## If you gave more than one scope

Only one of `--session`, `--feature` and `--last` is allowed. The command prints `gsd-atlas: choose one scope: --session, --feature <name> or --last` and exits 1.

## If you are not in the repository

Name it with `--repo <directory>`, or a directory inside it with `--cwd <directory>`.

For the result fields and every exit code, see [the CLI reference](../reference/cli.md#gsd-atlas-rate). For why agents cannot rate, see [About how atlas decides what to trust](../explanation/how-atlas-decides-what-to-trust.md#why-can-agents-not-rate-or-report).
