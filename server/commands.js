function parseCommand(text) {
  if (!text || !text.startsWith('!')) return null;
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);

  switch (cmd) {
    case '!start':
      return { action: 'start' };
    case '!stop':
    case '!end':
      return { action: 'stop' };
    case '!pause':
      return { action: 'pause' };
    case '!resume':
      return { action: 'resume' };
    case '!skip':
      return { action: 'skip' };
    case '!hint':
      return { action: 'hint' };
    case '!scores':
    case '!scoreboard':
      return { action: 'scores' };
    case '!kick':
      return { action: 'kick', target: args[0] || null };
    case '!say':
      return { action: 'say', message: args.join(' ') };
    case '!help':
      return { action: 'help' };
    default:
      return null;
  }
}

const HELP_TEXT = [
  '!start    - Start the quiz',
  '!stop     - End the quiz',
  '!pause    - Pause the quiz',
  '!resume   - Resume the quiz',
  '!skip     - Skip current question',
  '!hint     - Show a hint',
  '!scores   - Show scoreboard',
  '!kick <n> - Kick a player',
  '!say <m>  - Bot announcement',
  '!help     - Show this help'
];

module.exports = { parseCommand, HELP_TEXT };
