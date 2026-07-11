#!/bin/bash
# ============================================================================
# Gauss CTO autonomous Loop launcher
# ============================================================================

# Ensure dependencies & environment are sourced
if [ -f /home/dwizzy/.hermes/.env ]; then
    source /home/dwizzy/.hermes/.env
fi

# Run Claude Code CLI inside tmux with permissions skipped
# We will pipe the initial instructions into it or start it interactively.
claude --dangerously-skip-permissions --model hy3
