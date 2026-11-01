# zdrop.plugin.zsh — Kiro-style dropdown autocomplete for zsh.
#
# The shell side stays small and never blocks typing: every keystroke that changes the text before
# the cursor sends one line to a shared daemon over a unix socket, and replies are handled by a
# `zle -F` fd handler. The daemon (one per user, shared by every shell) runs the Fig specs.
#
# Source it last in .zshrc (after zsh-autosuggestions, fzf-tab, oh-my-zsh) so its key bindings win.

(( ${+_zdrop_loaded} )) && return 0
[[ -o interactive && ${ZDROP_DISABLE:-0} != 1 ]] || return 0
zmodload zsh/net/socket 2>/dev/null || return 0
zmodload -F zsh/datetime p:EPOCHREALTIME 2>/dev/null || return 0
zmodload -F zsh/parameter p:aliases 2>/dev/null
autoload -Uz add-zle-hook-widget add-zsh-hook
typeset -g _zdrop_loaded=1

# :a, not :A: keep ~/.zdrop/current unresolved so an update takes effect in shells that are already open
typeset -g _zdrop_root=${${(%):-%x}:a:h:h}
source "$_zdrop_root/zsh/zdrop-render.zsh"
typeset -g _zdrop_sock="${ZDROP_HOME:-$HOME/.cache/zdrop}/zdrop.sock"

# connection
typeset -gi _zdrop_fd=0 _zdrop_idle_fd=0 _zdrop_seq=0
typeset -gF _zdrop_started_at=0
typeset -g  _zdrop_sent_path=""           # PATH last sent to the daemon (commands are learned against it)
# what is on screen
typeset -g  _zdrop_state=hidden          # visible | hidden | dismissed (Esc: stays hidden until a new token)
typeset -ga _zdrop_items=()
typeset -gi _zdrop_sel=1 _zdrop_top=1 _zdrop_navigated=0
typeset -gi _zdrop_replace_len=0 _zdrop_typed_len=0 _zdrop_prompt_w=0
# cursor column of the card on screen, and of the query in flight (committed when its reply arrives,
# so repaints before then keep the card where it is)
typeset -gi _zdrop_anchor=1 _zdrop_query_anchor=1
typeset -gi _zdrop_desc_on=${ZDROP_DESCRIPTION:-1}
typeset -g  _zdrop_prefix="" _zdrop_arghint="" _zdrop_pending=""
typeset -gF _zdrop_sent_at=0
# editing state
typeset -g  _zdrop_last_lbuffer=""
typeset -gi _zdrop_inserting=0
typeset -g  _zdrop_keytimeout=${KEYTIMEOUT:-40}
typeset -gA _zdrop_orig=()               # raw key -> widget it had before zdrop bound it

# --- daemon connection --------------------------------------------------------------------------

_zdrop_connect() {
  (( _zdrop_fd )) && return 0
  if ! zsocket "$_zdrop_sock" 2>/dev/null; then
    # start the shared daemon (at most every 5s); a later keystroke connects
    if (( EPOCHREALTIME - _zdrop_started_at > 5 )); then
      _zdrop_started_at=$EPOCHREALTIME
      ( "$_zdrop_root/bin/zdrop" start >/dev/null 2>&1 & ) 2>/dev/null
    fi
    return 1
  fi
  _zdrop_fd=$REPLY
  zle -F $_zdrop_fd _zdrop_on_msg
  _zdrop_alias_line
  _zdrop_write "$REPLY" || return 1
  _zdrop_send_env
}

# the daemon is shared, so it resolves and learns commands against each shell's own PATH
_zdrop_send_env() {
  _zdrop_sent_path=$PATH
  _zdrop_write "E$_zdrop_US${PATH//[$'\n\x1e\x1f']/}$_zdrop_US${HISTFILE//[$'\n\x1e\x1f']/}"
}

_zdrop_disconnect() {
  (( _zdrop_fd )) || return 0
  zle -F $_zdrop_fd 2>/dev/null
  { exec {_zdrop_fd}<&- } 2>/dev/null
  _zdrop_fd=0
}

# write one line; a daemon that went away must not take the shell down with SIGPIPE
_zdrop_write() {
  setopt local_options local_traps
  trap '' PIPE
  print -r -u $_zdrop_fd -- "$1" 2>/dev/null
}

_zdrop_send() {
  _zdrop_connect || return 1
  _zdrop_write "$1" && return 0
  _zdrop_disconnect
  _zdrop_connect && _zdrop_write "$1"
}

# REPLY = the alias table as an `A` message (no command substitution: that would fork)
_zdrop_alias_line() {
  local -a kv=()
  local k
  for k in ${(k)aliases}; do kv+=("$k" "${aliases[$k]//[$'\n\x1e\x1f']/ }"); done
  REPLY="A$_zdrop_US${(pj:$_zdrop_US:)kv}"
}

# --- replies ------------------------------------------------------------------------------------

_zdrop_on_msg() {
  local fd=$1 line latest=""
  local -i reads=0 tick=0
  if [[ -n $2 ]]; then _zdrop_disconnect; return; fi
  while IFS= read -r -t 0 -u $fd line; do
    (( reads++ ))
    case $line in
      R$_zdrop_US$_zdrop_seq$_zdrop_US*) latest=$line ;;
      P$_zdrop_US$_zdrop_seq$_zdrop_US*) tick=1 ;;
    esac
  done
  # readable but nothing to read: the daemon closed the socket
  if (( reads == 0 )); then _zdrop_disconnect; return; fi

  if [[ -n $latest ]]; then
    # typing often leaves the results unchanged: then the card on screen is already right
    local before="$_zdrop_anchor$_zdrop_US$_zdrop_replace_len$_zdrop_US$_zdrop_sel$_zdrop_US$_zdrop_pending$_zdrop_US${(pj:$_zdrop_RS:)_zdrop_items}"
    _zdrop_take_result "$latest"
    local after="$_zdrop_anchor$_zdrop_US$_zdrop_replace_len$_zdrop_US$_zdrop_sel$_zdrop_US$_zdrop_pending$_zdrop_US${(pj:$_zdrop_RS:)_zdrop_items}"
    [[ $before == $after && -n $_zdrop_painted && -z $_zdrop_pending ]] || _zdrop_paint
    _zdrop_keys_mode
  elif (( tick )) && [[ $_zdrop_state == visible ]] && _zdrop_loading_due; then
    _zdrop_paint
  fi
}

_zdrop_take_result() {
  local -a recs=("${(@ps:$_zdrop_RS:)1}")
  local -a head=("${(@ps:$_zdrop_US:)recs[1]}")
  local selected=""
  (( _zdrop_navigated )) && selected=${${(ps:$_zdrop_US:)_zdrop_items[_zdrop_sel]}[2]}
  _zdrop_anchor=$_zdrop_query_anchor
  _zdrop_replace_len=$head[3] _zdrop_prefix=$head[4] _zdrop_arghint=$head[5] _zdrop_pending=$head[6]
  _zdrop_typed_len=$_zdrop_replace_len
  _zdrop_items=("${(@)recs[2,-1]}")
  # Kiro: selection resets to the top, unless the user had moved to an item that is still there
  _zdrop_sel=1 _zdrop_top=1
  if [[ -n $selected ]]; then
    local -i i
    for (( i = 1; i <= ${#_zdrop_items}; i++ )); do
      [[ ${${(ps:$_zdrop_US:)_zdrop_items[i]}[2]} == $selected ]] && { _zdrop_sel=i; break; }
    done
  fi
  _zdrop_state=visible
}

# Esc needs a short KEYTIMEOUT to feel instant, but only while the popup is up
_zdrop_keys_mode() {
  if _zdrop_active; then KEYTIMEOUT=1; else KEYTIMEOUT=$_zdrop_keytimeout; fi
}

# --- hooks --------------------------------------------------------------------------------------

_zdrop_measure_prompt() {
  setopt local_options extended_glob
  local p=$PS1
  # with prompt_subst, ${vcs_info_msg_0_}-style parts are expanded before the % escapes, as zsh does
  [[ -o prompt_subst ]] && p=${(e)p}
  p=${(%)p}
  p=${p//$'\e'\[[0-9;?]#[a-zA-Z]/}
  p=${p##*$'\n'}
  # a prompt longer than the window wraps; _zdrop_query takes the width modulo COLUMNS
  _zdrop_prompt_w=${(m)#p}
}

_zdrop_line_init() {
  _zdrop_last_lbuffer=$LBUFFER
  _zdrop_state=hidden
  _zdrop_measure_prompt
  _zdrop_connect || return
  [[ $PATH == $_zdrop_sent_path ]] || _zdrop_send_env
  _zdrop_write "N"
}

_zdrop_line_finish() {
  _zdrop_hide
  _zdrop_sync_end
}

_zdrop_query() {
  local line=${LBUFFER##*$'\n'}
  line=${line//[$'\x1e\x1f']/ }
  (( ++_zdrop_seq ))
  _zdrop_sent_at=$EPOCHREALTIME
  local -i width=${(m)#line}
  (( ${#line} == ${#LBUFFER} )) && (( width += _zdrop_prompt_w ))
  _zdrop_query_anchor=$(( width % ${COLUMNS:-80} + 1 ))
  _zdrop_send "Q$_zdrop_US$_zdrop_seq$_zdrop_US$PWD$_zdrop_US$line" || _zdrop_hide 0
}

_zdrop_pre_redraw() {
  # zle forgets the rows we reserved once a widget returns; reserve again on the next paint
  _zdrop_reserved=0
  if [[ $LBUFFER == $_zdrop_last_lbuffer ]]; then
    [[ -n $_zdrop_painted ]] && _zdrop_arm_repaint
    return
  fi
  local prev=$_zdrop_last_lbuffer
  _zdrop_last_lbuffer=$LBUFFER

  if (( _zdrop_inserting )); then
    _zdrop_inserting=0
  else
    # Kiro: a paste, history jump or word deletion hides the popup until the next keypress
    local -i delta=$(( ${#LBUFFER} - ${#prev} ))
    if (( delta > 1 || delta < -1 )) || [[ $LBUFFER != ${prev}* && $prev != ${LBUFFER}* ]]; then
      _zdrop_hide 0
      return
    fi
  fi

  if [[ $_zdrop_state == dismissed ]]; then
    [[ -z $LBUFFER || $LBUFFER == *[[:space:]] ]] || return
    _zdrop_state=hidden
  fi
  # nothing typed yet, or the cursor sits inside a word
  if [[ -z ${LBUFFER//[[:space:]]/} || $RBUFFER == [^[:space:]]* ]]; then
    _zdrop_hide 0
    return
  fi
  _zdrop_query
  # keep the previous card on screen until the answer (a few ms) replaces it: no flicker while typing
  [[ -n $_zdrop_painted ]] && _zdrop_arm_repaint
}

# Repaint after zle's own redraw: an fd handler on /dev/null runs as soon as zle waits for input.
# A synchronized frame begins here, before zle writes its refresh (which erases the card), and ends
# after the repaint, so the terminal shows the whole keystroke as one frame instead of blank-then-card.
_zdrop_arm_repaint() {
  (( _zdrop_idle_fd )) || { exec {_zdrop_idle_fd}</dev/null } 2>/dev/null || return
  zle -F $_zdrop_idle_fd _zdrop_on_idle
  _zdrop_sync_begin
}

_zdrop_on_idle() {
  zle -F $1
  _zdrop_repaint
  _zdrop_sync_end
}

# $1 = 1 (default) when zle may be told to release the reserved rows right now
_zdrop_hide() {
  (( _zdrop_seq++ ))   # any reply still on its way is now stale
  _zdrop_items=() _zdrop_pending="" _zdrop_arghint=""
  _zdrop_sel=1 _zdrop_top=1 _zdrop_navigated=0
  [[ $_zdrop_state == dismissed ]] || _zdrop_state=hidden
  if (( ${1:-1} )); then
    _zdrop_clear
  elif [[ -n $_zdrop_painted ]]; then
    printf '%s' $'\e7\e[B\e[G\e[J\e8'
    _zdrop_painted=""
  fi
  KEYTIMEOUT=$_zdrop_keytimeout
}

_zdrop_preexec() {
  _zdrop_sync_end
  # commands must not inherit the socket; reconnect at the next prompt
  _zdrop_disconnect
}

# --- widgets ------------------------------------------------------------------------------------

_zdrop_active() { [[ -n $_zdrop_painted ]] && (( ${#_zdrop_items} > 0 )) }

# run whatever the key did before zdrop bound it
_zdrop_fallback() {
  local widget=${_zdrop_orig[$KEYS]}
  [[ -n $widget ]] && zle $widget
}

_zdrop_field() { REPLY=${${(ps:$_zdrop_US:)_zdrop_items[$1]}[$2]}; }

_zdrop_insert() {
  local text=$1
  LBUFFER=${LBUFFER[1,-$(( _zdrop_replace_len + 1 ))]}
  if [[ $text == *'{cursor}'* ]]; then
    LBUFFER+=${text%%\{cursor\}*}
    RBUFFER=${text#*\{cursor\}}$RBUFFER
  else
    LBUFFER+=$text
  fi
  _zdrop_inserting=1
  _zdrop_navigated=0
}

_zdrop-accept() {
  _zdrop_active || { _zdrop_fallback; return }
  local -a f=("${(@ps:$_zdrop_US:)_zdrop_items[_zdrop_sel]}")
  if [[ $f[7] == auto-execute ]]; then
    _zdrop_hide
    _zdrop_fallback
    return
  fi
  _zdrop_insert "$f[3]"
}

# Tab: extend the token to the longest prefix all suggestions share; if that adds nothing, take the
# selected suggestion (a single real suggestion is taken directly)
_zdrop-tab() {
  setopt local_options extended_glob
  _zdrop_active || { _zdrop_fallback; return }
  local -a real=()
  local item
  for item in "${_zdrop_items[@]}"; do [[ $item == *${_zdrop_US}auto-execute ]] || real+=("$item"); done
  if (( ${#real} > 1 && ${#_zdrop_prefix} > _zdrop_replace_len )); then
    LBUFFER=${LBUFFER[1,-$(( _zdrop_replace_len + 1 ))]}${_zdrop_prefix//(#m)[[:space:]\'\"\\\$\`\!\&\|\;\<\>\(\)\*\?\[\]\{\}\#]/\\$MATCH}
    _zdrop_inserting=1
    return
  fi
  local pick=$_zdrop_items[_zdrop_sel]
  [[ $pick == *${_zdrop_US}auto-execute ]] && pick=$real[1]
  [[ -n $pick ]] && _zdrop_insert "${${(ps:$_zdrop_US:)pick}[3]}"
}

_zdrop-down() {
  _zdrop_active || { _zdrop_fallback; return }
  if (( _zdrop_sel < ${#_zdrop_items} )); then
    (( _zdrop_sel++ ))
  elif (( ${ZDROP_WRAP:-0} )); then
    _zdrop_sel=1
  fi
  _zdrop_navigated=1
  _zdrop_arm_repaint
}

_zdrop-up() {
  _zdrop_active || { _zdrop_fallback; return }
  if (( _zdrop_sel <= 1 )); then
    _zdrop_hide   # Kiro: moving up past the first row closes the popup
    return
  fi
  (( _zdrop_sel-- ))
  _zdrop_navigated=1
  _zdrop_arm_repaint
}

_zdrop-toggle-description() {
  _zdrop_active || { _zdrop_fallback; return }
  (( _zdrop_desc_on = !_zdrop_desc_on ))
  _zdrop_arm_repaint
}

_zdrop-escape() {
  if [[ -n $_zdrop_painted ]]; then
    _zdrop_state=dismissed
    _zdrop_hide
  else
    _zdrop_fallback
  fi
}

# --- setup --------------------------------------------------------------------------------------

typeset -ga _zdrop_widgets=(_zdrop-accept _zdrop-tab _zdrop-down _zdrop-up _zdrop-toggle-description _zdrop-escape)
for _zdrop_w_name in $_zdrop_widgets; do zle -N $_zdrop_w_name; done
unset _zdrop_w_name

# navigation must not make zsh-autosuggestions fetch or clear; accept/tab are ordinary edits to it
typeset -ga ZSH_AUTOSUGGEST_IGNORE_WIDGETS
ZSH_AUTOSUGGEST_IGNORE_WIDGETS+=(_zdrop-down _zdrop-up _zdrop-toggle-description _zdrop-escape)

# Bind after .zshrc has finished (first prompt), remembering what each key did so it still does that
# whenever the popup is not open.
_zdrop_bind_keys() {
  add-zsh-hook -d precmd _zdrop_bind_keys
  local -A current=()
  local entry key
  for entry in ${(f)"$(bindkey -M main)"}; do
    local -a words=(${(z)entry})
    current[${(Q)words[1]}]=$words[2]
  done
  # caret notation (as bindkey lists it)  raw bytes  zdrop widget  default when unbound
  local -a table=(
    '^M'    $'\r'    _zdrop-accept              accept-line
    '^I'    $'\t'    _zdrop-tab                 expand-or-complete
    '^[[B'  $'\e[B'  _zdrop-down                down-line-or-history
    '^[OB'  $'\eOB'  _zdrop-down                down-line-or-history
    '^N'    $'\x0e'  _zdrop-down                down-line-or-history
    '^[[A'  $'\e[A'  _zdrop-up                  up-line-or-history
    '^[OA'  $'\eOA'  _zdrop-up                  up-line-or-history
    '^P'    $'\x10'  _zdrop-up                  up-line-or-history
    '^[[Z'  $'\e[Z'  _zdrop-up                  ''
    '^K'    $'\x0b'  _zdrop-toggle-description  kill-line
    '^['    $'\e'    _zdrop-escape              ''
  )
  local -i i
  for (( i = 1; i <= ${#table}; i += 4 )); do
    local orig=${current[$table[i]]:-$table[i+3]}
    [[ $orig == _zdrop-* ]] && continue
    _zdrop_orig[$table[i+1]]=$orig
    bindkey -M main -- $table[i+1] $table[i+2]
  done

  # zsh-autosuggestions (async) draws its ghost text from its own fd handler, after our repaint
  if (( $+functions[_zsh_autosuggest_async_response] && ! $+functions[_zdrop_as_async_response] )); then
    functions -c _zsh_autosuggest_async_response _zdrop_as_async_response
    _zsh_autosuggest_async_response() {
      _zdrop_as_async_response "$@"
      local rc=$?
      [[ -n $_zdrop_painted ]] && _zdrop_repaint
      return rc
    }
  fi
}

# A resize redraws the prompt over the card. Traps run outside zle: only reset state here.
_zdrop_winch() {
  _zdrop_painted="" _zdrop_reserved=0 _zdrop_items=() _zdrop_state=hidden
  _zdrop_last_lbuffer=""
}
if (( $+functions[TRAPWINCH] )); then
  functions -c TRAPWINCH _zdrop_prev_trapwinch
  TRAPWINCH() { _zdrop_prev_trapwinch "$@"; local rc=$?; _zdrop_winch; return rc; }
else
  TRAPWINCH() { _zdrop_winch; }
fi

_zdrop_init_render
add-zle-hook-widget line-init _zdrop_line_init
add-zle-hook-widget line-finish _zdrop_line_finish
add-zle-hook-widget line-pre-redraw _zdrop_pre_redraw
add-zsh-hook preexec _zdrop_preexec
add-zsh-hook precmd _zdrop_bind_keys
