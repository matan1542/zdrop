# The README's demo. Record with: scripts/demo.sh (it sets up the fixture project and ZDROP_DEMO_RC).

Output docs/demo.gif

Require zsh
Set Shell "zsh"
Set FontSize 20
Set Width 1240
Set Height 520
Set Padding 20
Set TypingSpeed 75ms
Set Theme { "name": "zdrop", "background": "#1E1E1E", "foreground": "#D4D4D4", "cursor": "#D4D4D4", "selection": "#264F78", "black": "#1E1E1E", "red": "#F14C4C", "green": "#23D18B", "yellow": "#F5F543", "blue": "#3B8EEA", "magenta": "#D670D6", "cyan": "#29B8DB", "white": "#E5E5E5", "brightBlack": "#666666", "brightRed": "#F14C4C", "brightGreen": "#23D18B", "brightYellow": "#F5F543", "brightBlue": "#3B8EEA", "brightMagenta": "#D670D6", "brightCyan": "#29B8DB", "brightWhite": "#E5E5E5" }

Hide
Type "source $ZDROP_DEMO_RC && clear"
Enter
Sleep 1.5s
Show

# subcommands with a docs panel; Tab moves; Enter fills in, then branches (the one you use first)
Type "git ch"
Sleep 1.5s
Tab
Sleep 1s
Tab
Sleep 0.8s
Enter
Sleep 1.5s
Type "fe"
Sleep 1s
Down
Sleep 0.8s
Enter
Sleep 1s
Ctrl+U
Sleep 0.4s

# package.json scripts
Type "yarn "
Sleep 1.5s
Type "t"
Sleep 0.8s
Down
Sleep 1s
Ctrl+U
Sleep 0.4s

# a CLI with no spec, learned from its --help on first use
Type "deploy-tool "
Sleep 2s
Down
Sleep 1s
Down
Sleep 0.8s
Ctrl+U
Type "deploy-tool re"
Sleep 1s
Enter
Sleep 1.5s
Type "--"
Sleep 1.5s
Ctrl+U
Sleep 0.4s

# a mistyped command gets a fix; Enter applies it
Type "gti status "
Sleep 1.5s
Enter
Sleep 1.5s
Ctrl+U
Sleep 0.6s
