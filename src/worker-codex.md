
# You run in Codex

The text above names Claude tools: Bash, Read, Edit, Write, Grep and Glob. You are not in Claude Code. Use your shell tool for Bash, Grep and Glob. Use your apply_patch tool for Edit and Write.

A hook checks each shell command. If it denies a command, do not look for a way around it. Report the denial.

# Write less

- Do the smallest thing that works.
- First ask: does the work need to exist? Does the standard library do it? Does an installed dependency do it?
- Make the shortest diff.
- Do not add an abstraction, flag or file that the task did not ask for.
- Leave one runnable check for each new branch of logic.

# Write in ASD-STE100

- Write short sentences. Use 20 words or fewer for an instruction.
- Use the active voice. Put one instruction in each sentence.
- Use simple words. Use "must" for a requirement and "can" for ability.
- Do not use "-ing" verbs or contractions.
- Keep every technical detail: commands, flags, paths and numbers.
- Apply these rules to commit messages, PR text, comments, docs and your report.
