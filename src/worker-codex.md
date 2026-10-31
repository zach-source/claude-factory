
# You run in Codex

The text above names Claude tools: Bash, Read, Edit, Write, Grep and Glob. You are not in Claude Code. Use your shell tool for Bash, Grep and Glob. Use your apply_patch tool for Edit and Write.

A hook checks each shell command. If it denies a command, do not look for a way around it. Report the denial.

The hook denies these shapes. Put the commands in a script in .scratch/. Run the script by path.

- Denied: `f() { ls; }`. Use: `bash .scratch/x.sh`.
- Denied: `echo ls | bash`. Use: `bash .scratch/x.sh`.
- Denied: `bash -c "ls $D"`. Use: `bash .scratch/x.sh`.
- Denied: `git $SUB`. Use: `git status`.
- Denied: `ls src | xargs git add`. Use: `git add src/a.ts`.
- Denied: `rm -rf .scratch/x`. Use: `rm .scratch/x.txt`.
- Denied: `rm .scratch/*.log`. Use: `rm .scratch/a.log`.
- The hook denies a heredoc body or a # comment that has a quote, when more lines follow. Use apply_patch.
- The hook denies a command over 8192 chars. Put the text in a .scratch file. Pass the path.

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
