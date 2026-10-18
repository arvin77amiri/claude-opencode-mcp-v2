# Brief templates

Adapt these; remove lines that don't apply. Fill in every `<...>`. The agent sees nothing except
this text, the workspace path and its permissions.

## researcher: map an area

```text
Goal: understand how <feature/subsystem> works so I can <what you plan to do next>.

Context: <what you already know; files you've seen; the user's question>.

Answer these questions:
1. Where is <X> implemented (entry points, main modules, files and functions)?
2. How does data flow from <A> to <B>?
3. What depends on <module> (callers, tests, config)?
4. <Specific question>

Don't modify anything. Give file paths with line numbers for each claim. List open questions or risks
under "## Findings" as `- [severity: low|medium|high] Title (path:line) — detail`.
```

Useful `paths`: the directories you suspect are relevant.

## coder: implement a change

```text
Goal: <change> because <reason>.

Context:
- Relevant code: <path:function>, <path:function>.
- Conventions to follow: <e.g. errors use BridgeError; tests live next to the code in tests/unit>.
- Decisions already made: <e.g. no new dependencies; keep the public API unchanged>.

Scope:
- Change: <files/areas>.
- Don't touch: <files/areas>.

Done when:
- <behaviour criterion>.
- `<test command>` passes (add or update tests for <case>).

Report in your standard format (Summary, Changes, Verification, Follow-ups). In Verification, paste the
exact commands you ran and whether they passed.
```

## coder: follow-up after a review (send_message on the same session)

```text
The review found these problems in your changes. Fix them, keep everything else as is, and run
`<test command>` again:

1. [high] <title> (<path:line>): <what is wrong and the expected behaviour>.
2. [medium] <title> (<path:line>): <...>.

Skip <finding N> because <reason>. Report what you changed and the test results.
```

## reviewer: review a coder's changes

```text
Review the changes made to implement <goal>.

Changed files: <list from get_diff>.
Intended behaviour: <one paragraph>.
Things I specifically want checked: <edge cases, error handling, concurrency, security of input X>.

Report only material issues (no style nits), each grounded in code you read, in the format
`- [severity: critical|high|medium|low] Title (path:line) — impact and suggested fix`, then a Verdict.
```

Pass the changed files as `paths`.

## tester: run and diagnose tests

```text
Run the tests relevant to <change/area> and explain any failures.

Commands: <`npm test -- tests/unit/foo.test.ts`, then the full suite `npm test`>.
(If these are wrong, find the right ones in package.json / Makefile / CI config.)

Also check: <a scenario that should be exercised, e.g. empty input, concurrent calls>.

Don't modify files. For each failure, give the root cause as
`- [severity: ...] Title (path:line) — why it fails` and a suggested fix.
```
