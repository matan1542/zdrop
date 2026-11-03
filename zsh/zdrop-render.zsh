# zdrop-render.zsh — draws the Kiro-style popup below the prompt with raw ANSI.
#
# Technique (from nerv-sh/nerv): `zle -R "" <blank rows>` makes zle reserve screen rows below the
# command line (and scroll when the prompt is at the bottom), then one printf paints the coloured
# card over those blanks between a cursor save (\e7) and restore (\e8). Only relative moves are used.
#
# Look (from Amazon Q's open autocomplete UI, which Kiro inherited): solid card, blue selected row,
# matched characters on a highlight background, common prefix underlined, dimmed args, and an italic
# description bar under a separator. Loading: three marching dots, or a spinner in the description bar.

typeset -g _zdrop_US=$'\x1f' _zdrop_RS=$'\x1e'
typeset -gA _zdrop_c=()            # theme token -> SGR escape
typeset -gA _zdrop_glyph=()        # icon key -> single-cell glyph
typeset -gi _zdrop_w=${ZDROP_WIDTH:-44}
typeset -gi _zdrop_max_rows=${ZDROP_MAX_ROWS:-7}
typeset -gi _zdrop_docs_w=${ZDROP_DOCS_WIDTH:-36}
# where the highlighted item's description goes: a panel beside the list, a bar below it, or nowhere
typeset -g  _zdrop_docs=${ZDROP_DOCS:-side}
[[ ${ZDROP_DESCRIPTION:-1} == 0 ]] && _zdrop_docs=off
typeset -gi _zdrop_reserved=0      # rows currently reserved with zle -R
typeset -ga _zdrop_reserved_rows=()
typeset -g  _zdrop_painted=""      # last frame painted (non-empty while the card is on screen)
typeset -gi _zdrop_sync=1          # wrap redraws in synchronized output (DEC mode 2026)
typeset -gi _zdrop_sync_open=0     # a synchronized frame has begun and not yet ended

# --- colours -------------------------------------------------------------------------------------

# blend two #rrggbb colours: _zdrop_blend <fg> <bg> <alpha 0-100>  → REPLY=rrggbb
_zdrop_blend() {
  local a=$1 b=$2 alpha=$3 out="" i
  for i in 1 3 5; do
    out+=${(l:2::0:)$(( [##16] (16#${a[i,i+1]} * alpha + 16#${b[i,i+1]} * (100 - alpha)) / 100 ))}
  done
  REPLY=$out
}

# nearest xterm-256 index for rrggbb → REPLY
_zdrop_hex256() {
  local -i r=16#${1[1,2]} g=16#${1[3,4]} b=16#${1[5,6]}
  local -a lv=(0 95 135 175 215 255)
  local -i ri gi bi i d best=0 bd=1000000 cr cg cb
  for (( i = 1; i <= 6; i++ )); do
    (( d = (r - lv[i]) ** 2 )); (( d < bd )) && { bd=d; ri=i; }
  done; bd=1000000
  for (( i = 1; i <= 6; i++ )); do
    (( d = (g - lv[i]) ** 2 )); (( d < bd )) && { bd=d; gi=i; }
  done; bd=1000000
  for (( i = 1; i <= 6; i++ )); do
    (( d = (b - lv[i]) ** 2 )); (( d < bd )) && { bd=d; bi=i; }
  done
  (( cr = lv[ri], cg = lv[gi], cb = lv[bi] ))
  (( best = 16 + 36 * (ri - 1) + 6 * (gi - 1) + (bi - 1) ))
  (( bd = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2 ))
  local -i avg=$(( (r + g + b) / 3 )) gray gidx
  (( gidx = (avg - 8) / 10 )); (( gidx < 0 )) && gidx=0; (( gidx > 23 )) && gidx=23
  (( gray = 8 + 10 * gidx ))
  (( (r - gray) ** 2 + (g - gray) ** 2 + (b - gray) ** 2 < bd )) && best=$(( 232 + gidx ))
  REPLY=$best
}

# _zdrop_set_colour <token> <fg|bg> <rrggbb>
_zdrop_set_colour() {
  local layer=38; [[ $2 == bg ]] && layer=48
  if [[ $COLORTERM == (truecolor|24bit) ]]; then
    _zdrop_c[$1]=$'\e['"$layer;2;$(( 16#${3[1,2]} ));$(( 16#${3[3,4]} ));$(( 16#${3[5,6]} ))m"
  else
    local REPLY; _zdrop_hex256 $3
    _zdrop_c[$1]=$'\e['"$layer;5;${REPLY}m"
  fi
}

_zdrop_load_theme() {
  local bg fg border sel_bg sel_fg match sel_match nodesc REPLY
  if [[ ${ZDROP_THEME:-dark} == light ]]; then
    bg=FEFEFE fg=070707 border=C7C7C7 sel_bg=2969DA sel_fg=FDFDFD match=FFEF98 sel_match=6A8EDA nodesc=8C8C8C
  else
    bg=303030 fg=B4B4B4 border=414141 sel_bg=1E5AC7 sel_fg=FDFDFD match=5F5938 sel_match=6A8EDA nodesc=8C8C8C
  fi
  _zdrop_set_colour bg bg $bg
  _zdrop_set_colour fg fg $fg
  _zdrop_set_colour border fg $border
  _zdrop_set_colour sel_bg bg $sel_bg
  _zdrop_set_colour sel_fg fg $sel_fg
  _zdrop_set_colour nodesc fg $nodesc
  _zdrop_blend $match $bg 80;          _zdrop_set_colour match_bg bg $REPLY
  _zdrop_blend $sel_match $sel_bg 80;  _zdrop_set_colour sel_match_bg bg $REPLY
  _zdrop_blend $fg $bg 50;             _zdrop_set_colour args_fg fg $REPLY
  _zdrop_blend $sel_fg $sel_bg 55;     _zdrop_set_colour sel_args_fg fg $REPLY
  _zdrop_blend $fg $bg 7;              _zdrop_set_colour panel_bg bg $REPLY
}

# --- icons (every glyph is one cell; emoji and wide glyphs would break the column maths) ---------

_zdrop_load_icons() {
  _zdrop_glyph=()
  case ${ZDROP_ICONS:-unicode} in
    nerd)
      _zdrop_glyph=(
        subcommand $'' option $'' arg $'' file $'' folder $''
        auto-execute $'' shortcut $'' special $'' mixin $'' default $''
        fig:git $'' fig:commit $'' fig:npm $'' fig:yarn $'' fig:node $''
        fig:docker $'' fig:kubernetes $'' fig:aws $'' fig:github $''
        history $'\uf1da' frecent $'\uf07c' function $'\uf121' typo $'\uf0eb'
      ) ;;
    none) ;;
    *)
      _zdrop_glyph=(
        subcommand '›' option '⚑' arg '◇' file '≡' folder '▸' auto-execute '↪'
        shortcut '★' special '★' mixin '◆' default '•' history '↺' frecent '⌂' function 'λ' typo '↯'
        fig:git '⎇' fig:commit '⎇' fig:npm '⬢' fig:yarn '⬢' fig:node '⬢'
      ) ;;
  esac
}

_zdrop_icon() {
  if [[ ${ZDROP_ICONS:-unicode} == none ]]; then REPLY=' '; return; fi
  REPLY=${_zdrop_glyph[$1]:-${_zdrop_glyph[default]:-•}}
}

_zdrop_init_render() {
  _zdrop_load_theme
  _zdrop_load_icons
  # Mode 2026 makes the terminal show zle's clear and our paint as one frame (no flicker). Terminals
  # without it ignore the sequence; Terminal.app is skipped to be conservative.
  _zdrop_sync=1
  [[ ${ZDROP_SYNC:-1} == 0 || $TERM_PROGRAM == Apple_Terminal ]] && _zdrop_sync=0
}

_zdrop_sync_begin() {
  (( _zdrop_sync && !_zdrop_sync_open )) || return 0
  printf '\e[?2026h'
  _zdrop_sync_open=1
}

_zdrop_sync_end() {
  (( _zdrop_sync_open )) || return 0
  printf '\e[?2026l'
  _zdrop_sync_open=0
}

# --- text helpers ----------------------------------------------------------------------------------

# _zdrop_clip <text> <cells> → REPLY = text cut to at most <cells> display cells
_zdrop_clip() {
  local text=$1 c out=""
  local -i budget=$2 cw used=0 i
  if (( ${(m)#text} <= budget )); then REPLY=$text; return; fi
  for (( i = 1; i <= ${#text}; i++ )); do
    c=${text[i]}; cw=${(m)#c}
    (( used + cw > budget )) && break
    out+=$c; (( used += cw ))
  done
  REPLY=$out
}

_zdrop_pad() { REPLY="${(l:$1:: :)}"; (( $1 <= 0 )) && REPLY=""; }

# _zdrop_wrap <text> <cells> <max lines> → _zdrop_wrapped = the text word-wrapped (the last line
# ends in … when it doesn't fit)
typeset -ga _zdrop_wrapped=()
_zdrop_wrap() {
  local text=$1 word line="" REPLY
  local -i width=$2 max=$3
  _zdrop_wrapped=()
  for word in ${=text}; do
    if [[ -z $line ]]; then
      line=$word
    elif (( ${(m)#line} + 1 + ${(m)#word} <= width )); then
      line+=" $word"
    else
      _zdrop_wrapped+=("$line"); line=$word
    fi
    # a word longer than the line is cut into pieces
    while (( ${(m)#line} > width )); do
      _zdrop_clip "$line" $width
      _zdrop_wrapped+=("$REPLY"); line=${line#$REPLY}
    done
  done
  [[ -n $line ]] && _zdrop_wrapped+=("$line")
  if (( ${#_zdrop_wrapped} > max )); then
    _zdrop_clip "$_zdrop_wrapped[max]" $(( width - 1 ))
    _zdrop_wrapped=("${(@)_zdrop_wrapped[1,max-1]}" "$REPLY…")
  fi
}

# --- rows ------------------------------------------------------------------------------------------

# _zdrop_row <record> <selected> → REPLY = one coloured row exactly _zdrop_w cells wide
# (REPLY is deliberately not local here or in the helpers below: it is how they return)
_zdrop_row() {
  local -a f=("${(@ps:$_zdrop_US:)1}")
  local key=$f[1] name=$f[2] args=$f[5] matches=$f[6] type=$f[7]
  local bg fg mbg afg
  if (( $2 )); then
    bg=$_zdrop_c[sel_bg] fg=$_zdrop_c[sel_fg] mbg=$_zdrop_c[sel_match_bg] afg=$_zdrop_c[sel_args_fg]
  else
    bg=$_zdrop_c[bg] fg=$_zdrop_c[fg] mbg=$_zdrop_c[match_bg] afg=$_zdrop_c[args_fg]
  fi
  _zdrop_icon $key
  local out="$bg$fg $REPLY "
  local -i inner=$(( _zdrop_w - 4 )) used=0 i cw
  local -A hit=()
  local idx; for idx in ${(s:,:)matches}; do hit[$(( idx + 1 ))]=1; done
  local -i under=0
  [[ $type != auto-execute && -n $_zdrop_prefix && ${#_zdrop_prefix} -gt ${_zdrop_typed_len:-0} && $name == ${_zdrop_prefix}* ]] && under=${#_zdrop_prefix}

  local c
  for (( i = 1; i <= ${#name}; i++ )); do
    c=${name[i]}; cw=${(m)#c}
    (( used + cw > inner )) && break
    if (( ${+hit[$i]} )); then out+="$mbg"; fi
    (( i <= under )) && out+=$'\e[4m'
    out+=$c
    (( i <= under )) && out+=$'\e[24m'
    (( ${+hit[$i]} )) && out+="$bg"
    (( used += cw ))
  done
  if [[ -n $args ]] && (( used + 3 < inner )); then
    _zdrop_clip "$args" $(( inner - used - 2 ))
    out+="  $afg$REPLY$fg"
    (( used += 2 + ${(m)#REPLY} ))
  fi
  _zdrop_pad $(( inner - used ))
  REPLY="$out$REPLY "$'\e[0m'
}

_zdrop_separator() {
  REPLY="$_zdrop_c[bg]$_zdrop_c[border]${(pl:$_zdrop_w::─:)}"$'\e[0m'
}

typeset -ga _zdrop_spinner=(⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏)
typeset -ga _zdrop_dots=('●··' '·●·' '··●' '·●·')

_zdrop_loading_due() {
  [[ -n $_zdrop_pending ]] && (( EPOCHREALTIME - _zdrop_sent_at >= 0.2 ))
}

# description bar for the selected record (or the loading spinner while a generator runs)
_zdrop_description() {
  local -a f=("${(@ps:$_zdrop_US:)1}")
  local desc=$f[4] type=$f[7] colour=$_zdrop_c[fg] hint="⌃k"
  if [[ -n $_zdrop_notice ]] && (( ! _zdrop_navigated )); then
    desc="⬆ $_zdrop_notice" colour=$_zdrop_c[args_fg]
  elif _zdrop_loading_due; then
    # frame from the clock, not a counter, so merged or dropped ticks never stutter
    local -i ms=$(( EPOCHREALTIME * 1000 ))
    desc="$_zdrop_spinner[$(( ms / 80 % 10 + 1 ))] loading $_zdrop_pending…"
  elif [[ -z $desc ]]; then
    case $type in
      folder) desc="folder" ;;
      file) desc="file" ;;
      *) desc="No description"; colour=$_zdrop_c[nodesc] ;;
    esac
  fi
  # layout: " " text pad hint " "  (hint keeps at least one space of gap)
  _zdrop_clip "$desc" $(( _zdrop_w - 3 - ${(m)#hint} - 1 ))
  local text=$REPLY
  _zdrop_pad $(( _zdrop_w - 2 - ${(m)#text} - ${(m)#hint} ))
  REPLY="$_zdrop_c[bg]$colour"$'\e[3m'" $text$REPLY"$'\e[23m'"$_zdrop_c[args_fg]$hint "$'\e[0m'
}

# _zdrop_panel <record> <min height> <max height> → _zdrop_panel_lines: the docs panel beside the list,
# each line exactly _zdrop_docs_w cells: the name and its arguments, the whole description, then what
# the item is (or the loading spinner / update notice) on the last line.
typeset -ga _zdrop_panel_lines=()
_zdrop_panel() {
  local -a f=("${(@ps:$_zdrop_US:)1}")
  local name=$f[2] desc=$f[4] args=$f[5] type=$f[7] REPLY
  local -i h=$2 hmax=$3 w=$(( _zdrop_docs_w - 2 )) i
  local bg=$_zdrop_c[panel_bg] fg=$_zdrop_c[fg] dim=$_zdrop_c[args_fg]
  local -a body=()

  _zdrop_clip "$name" $w
  local title=$REPLY
  local -i used=${(m)#title}
  local line=$'\e[1m'"$title"$'\e[22m'
  if [[ -n $args ]] && (( used + 3 < w )); then
    _zdrop_clip "$args" $(( w - used - 1 ))
    line+=" $dim$REPLY$fg"; (( used += 1 + ${(m)#REPLY} ))
  fi
  _zdrop_pad $(( w - used ))
  body+=("$line$REPLY")

  local footer="" fcolour=$dim
  if [[ -n $_zdrop_notice ]] && (( ! _zdrop_navigated )); then
    footer="⬆ $_zdrop_notice"
  elif _zdrop_loading_due; then
    local -i ms=$(( EPOCHREALTIME * 1000 ))
    footer="$_zdrop_spinner[$(( ms / 80 % 10 + 1 ))] loading $_zdrop_pending…" fcolour=$fg
  else
    # Fig leaves the type empty for most items; the icon key says what they are
    local kind=${type:-$f[1]}
    [[ $f[1] == function ]] && kind=function
    case $kind in
      subcommand) footer="command" ;;
      option) footer="option${args:+ · takes $args}" ;;
      arg) footer="value" ;;
      shortcut) footer="alias" ;;
      function) footer="shell function" ;;
      typo) footer="Enter fixes the line" ;;
      history) footer="from your history" ;;
      folder|file|frecent) footer=${${type:-folder}/frecent/folder} ;;
    esac
  fi

  local -i room=$(( hmax - 1 - (${#footer} > 0) ))
  if [[ -z $desc ]]; then
    [[ $type == (folder|file) ]] || { _zdrop_wrapped=("$_zdrop_c[nodesc]No description$fg"); _zdrop_pad $(( w - 14 )); body+=("$_zdrop_wrapped[1]$REPLY"); }
  else
    _zdrop_wrap "$desc" $w $(( room > 0 ? room : 1 ))
    for line in "${_zdrop_wrapped[@]}"; do
      _zdrop_pad $(( w - ${(m)#line} )); body+=("$line$REPLY")
    done
  fi
  # taller than the list when the description needs it
  (( ${#body} + (${#footer} > 0) > h )) && h=$(( ${#body} + (${#footer} > 0) ))
  while (( ${#body} < h - (${#footer} > 0) )); do _zdrop_pad $w; body+=("$REPLY"); done
  if [[ -n $footer ]]; then
    _zdrop_clip "$footer" $(( w - 4 ))
    local text=$REPLY
    _zdrop_pad $(( w - ${(m)#text} - 2 ))
    body+=("$fcolour"$'\e[3m'"$text"$'\e[23m'"$REPLY$dim⌃k$fg")
  fi
  _zdrop_panel_lines=()
  for (( i = 1; i <= h; i++ )); do _zdrop_panel_lines+=("$bg$fg ${body[i]} "$'\e[0m'); done
}

# --- frame + paint ---------------------------------------------------------------------------------

# Builds _zdrop_frame (coloured rows) and _zdrop_frame_w from the current state.
_zdrop_build_frame() {
  _zdrop_frame=()
  local REPLY
  local -i n=${#_zdrop_items}
  if (( n == 0 )); then
    if _zdrop_loading_due; then
      local -i ms=$(( EPOCHREALTIME * 1000 ))
      _zdrop_frame=("$_zdrop_c[bg]$_zdrop_c[fg]  $_zdrop_dots[$(( ms / 165 % 4 + 1 ))]  "$'\e[0m')
      _zdrop_frame_w=7
    elif [[ -n $_zdrop_arghint ]]; then
      _zdrop_clip "$_zdrop_arghint" $(( _zdrop_w - 4 ))
      _zdrop_frame=("$_zdrop_c[bg]$_zdrop_c[args_fg] ◇ $_zdrop_c[fg]"$'\e[1m'"$REPLY"$'\e[22m'" "$'\e[0m')
      _zdrop_frame_w=$(( ${(m)#REPLY} + 4 ))
    fi
    return
  fi

  local -i rows=$_zdrop_max_rows
  (( rows > LINES - 4 )) && rows=$(( LINES - 4 ))
  (( rows < 1 )) && rows=1
  (( rows > n )) && rows=n
  # keep the selection inside the visible window
  (( _zdrop_sel < _zdrop_top )) && _zdrop_top=$_zdrop_sel
  (( _zdrop_sel >= _zdrop_top + rows )) && _zdrop_top=$(( _zdrop_sel - rows + 1 ))
  (( _zdrop_top < 1 )) && _zdrop_top=1

  local -i i
  for (( i = _zdrop_top; i < _zdrop_top + rows; i++ )); do
    _zdrop_row "$_zdrop_items[i]" $(( i == _zdrop_sel ))
    _zdrop_frame+=("$REPLY")
  done
  _zdrop_frame_w=$_zdrop_w

  local docs=$_zdrop_docs
  # beside the list when the window is wide enough, below it otherwise
  [[ $docs == side ]] && (( _zdrop_w + 1 + _zdrop_docs_w > ${COLUMNS:-80} )) && docs=below
  case $docs in
    side)
      # as tall as the list, or taller (up to the row limit) for a long description
      local -i hmax=$(( _zdrop_max_rows > rows ? _zdrop_max_rows : rows ))
      (( hmax > LINES - 4 )) && hmax=$(( LINES - 4 > rows ? LINES - 4 : rows ))
      _zdrop_panel "$_zdrop_items[_zdrop_sel]" $rows $hmax
      local blank=${(l:_zdrop_w:: :)}
      for (( i = 1; i <= ${#_zdrop_panel_lines}; i++ )); do
        # rows below a short list are left blank (no card background)
        _zdrop_frame[i]="${_zdrop_frame[i]:-$blank} $_zdrop_panel_lines[i]"
      done
      _zdrop_frame_w=$(( _zdrop_w + 1 + _zdrop_docs_w ))
      ;;
    below)
      _zdrop_separator; _zdrop_frame+=("$REPLY")
      _zdrop_description "$_zdrop_items[_zdrop_sel]"; _zdrop_frame+=("$REPLY")
      ;;
  esac
}

# Paints the current state (or clears when there is nothing to show).
# Paints the current state (or clears when there is nothing to show). Inside a synchronized frame the
# caller opened, it just draws; otherwise it wraps its own output in one.
_zdrop_paint() {
  local -i own_frame=$(( !_zdrop_sync_open ))
  _zdrop_sync_begin
  _zdrop_draw
  (( own_frame )) && _zdrop_sync_end
  return 0
}

_zdrop_draw() {
  local -a _zdrop_frame=()
  local -i _zdrop_frame_w=0
  _zdrop_build_frame
  if (( ${#_zdrop_frame} == 0 )); then
    _zdrop_clear
    return
  fi

  local -i cols=${COLUMNS:-80}
  # names line up under the token being completed (the card's padding + icon + space sit to its left)
  local -i col=$(( _zdrop_anchor - _zdrop_replace_len - 3 ))
  (( col + _zdrop_frame_w > cols )) && col=$(( cols - _zdrop_frame_w ))
  (( col < 1 )) && col=1

  local -i want=${#_zdrop_frame}
  if (( _zdrop_reserved != want )); then
    # each blank must own a whole line: zle columnates its list, COLUMNS-3 leaves room for the gap
    local -i blank_w=$(( cols > 4 ? cols - 3 : 1 ))
    local blank=${(l:blank_w:: :)}
    _zdrop_reserved_rows=()
    repeat $want; do _zdrop_reserved_rows+=("$blank"); done
    _zdrop_reserved=$want
    zle -R "" "${_zdrop_reserved_rows[@]}"
  fi

  local move=$'\e[B\e['"${col}G"
  local buf=$'\e7' row
  for row in "${_zdrop_frame[@]}"; do buf+="$move$row"$'\e[K'; done
  buf+=$'\e[J\e8'
  _zdrop_painted=$buf
  printf '%s' "$buf"
}

# Paint again after zle redrew the line (its refresh erases the rows we reserved).
_zdrop_repaint() {
  [[ -n $_zdrop_painted ]] || return 0
  _zdrop_paint
}

_zdrop_clear() {
  if [[ -n $_zdrop_painted || $_zdrop_reserved -gt 0 ]]; then
    printf '%s' $'\e7\e[B\e[G\e[J\e8'
    zle -R ""
  fi
  _zdrop_painted=""
  _zdrop_reserved=0
  _zdrop_reserved_rows=()
}
