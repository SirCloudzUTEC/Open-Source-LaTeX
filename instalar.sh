#!/usr/bin/env bash
# Instalador de LocalTeX: verifica e instala todo lo necesario, compila la app
# y crea el acceso directo en el menú de aplicaciones.
#
# Uso:
#   ./instalar.sh            menú interactivo
#   ./instalar.sh --todo     instala todo sin preguntar (pide sudo una vez)
#   ./instalar.sh --verificar   solo muestra qué falta
#   ./instalar.sh --dev      abre la app en modo desarrollo
#   ./instalar.sh --desinstalar quita el binario y el acceso directo

set -uo pipefail

APP_NAME="LocalTeX"
APP_ID="localtex"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="$DIR/instalar.log"
BIN_DIR="$HOME/.local/bin"
DESKTOP_DIR="$HOME/.local/share/applications"
ICON_DIR="$HOME/.local/share/icons/hicolor/128x128/apps"
export PATH="$HOME/.cargo/bin:$BIN_DIR:$PATH"

# ---------------------------------------------------------------- estética --
if [[ -t 1 ]]; then
  B=$'\e[1m' D=$'\e[2m' R=$'\e[31m' G=$'\e[32m' Y=$'\e[33m' C=$'\e[36m' N=$'\e[0m'
else
  B="" D="" R="" G="" Y="" C="" N=""
fi
ok()    { printf "  ${G}✔${N} %s\n" "$*"; }
miss()  { printf "  ${R}✘${N} %s\n" "$*"; }
warn()  { printf "  ${Y}!${N} %s\n" "$*"; }
info()  { printf "  ${C}›${N} %s\n" "$*"; }
title() { printf "\n${B}%s${N}\n" "$*"; }
die()   { printf "\n${R}${B}Error:${N} %s\n${D}Revisa el detalle en %s${N}\n" "$*" "$LOG"; exit 1; }

# Ejecuta un comando mostrando un spinner; la salida va al log.
run() {
  local msg="$1"; shift
  [[ -t 1 ]] && printf "  ${C}…${N} %s" "$msg"
  echo -e "\n\$ $*" >>"$LOG"
  "$@" >>"$LOG" 2>&1 &
  local pid=$! frames='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏' i=0
  while kill -0 "$pid" 2>/dev/null; do
    [[ -t 1 ]] && printf "\r  ${C}%s${N} %s" "${frames:i++%${#frames}:1}" "$msg"
    sleep 0.1
  done
  local cr=""; [[ -t 1 ]] && cr=$'\r'
  if wait "$pid"; then
    printf "%s  ${G}✔${N} %s\n" "$cr" "$msg"
  else
    printf "%s  ${R}✘${N} %s\n" "$cr" "$msg"
    tail -n 15 "$LOG" | sed "s/^/    ${D}/;s/$/${N}/"
    return 1
  fi
}

has() { command -v "$1" >/dev/null 2>&1; }

banner() {
  printf "${G}${B}"
  cat <<'EOF'
   _                    _ _____   __  __
  | |    ___   ___ __ _| |_   _|__\ \/ /
  | |   / _ \ / __/ _` | | | |/ _ \\  /
  | |__| (_) | (_| (_| | | | |  __//  \
  |_____\___/ \___\__,_|_| |_|\___/_/\_\
EOF
  printf "${N}${D}  Instalador · editor LaTeX local${N}\n"
}

# ------------------------------------------------------------ distribución --
detect_distro() {
  DISTRO="desconocida"
  PM=""
  if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    local ids="${ID:-} ${ID_LIKE:-}"
    case "$ids" in
      *fedora*|*rhel*|*centos*) DISTRO="${PRETTY_NAME:-Fedora}"; PM="dnf" ;;
      *debian*|*ubuntu*)        DISTRO="${PRETTY_NAME:-Debian}"; PM="apt" ;;
      *arch*)                   DISTRO="${PRETTY_NAME:-Arch}";   PM="pacman" ;;
      *suse*)                   DISTRO="${PRETTY_NAME:-openSUSE}"; PM="zypper" ;;
    esac
  fi
}

# Paquetes por gestor. TeX solo se instala si falta.
pkgs_system() {
  case "$PM" in
    dnf)    echo "webkit2gtk4.1-devel gtk3-devel libsoup3-devel javascriptcoregtk4.1-devel librsvg2-devel libappindicator-gtk3-devel openssl-devel gcc gcc-c++ make pkgconf-pkg-config curl file" ;;
    apt)    echo "libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev librsvg2-dev libayatana-appindicator3-dev libssl-dev libxdo-dev build-essential pkg-config curl file" ;;
    pacman) echo "webkit2gtk-4.1 gtk3 libsoup3 librsvg libappindicator-gtk3 openssl base-devel pkgconf curl file" ;;
    zypper) echo "webkit2gtk3-devel libsoup3-devel librsvg-devel libappindicator3-devel libopenssl-devel gcc gcc-c++ make pkg-config curl file" ;;
  esac
}

pkgs_tex_full() {
  case "$PM" in
    dnf)    echo "texlive-scheme-medium latexmk texlive-synctex texlive-texcount texlive-babel-spanish texlive-beamer" ;;
    apt)    echo "texlive-latex-recommended texlive-latex-extra texlive-fonts-recommended texlive-lang-spanish texlive-science texlive-xetex texlive-luatex texlive-extra-utils texlive-bibtex-extra biber latexmk" ;;
    pacman) echo "texlive-basic texlive-latex texlive-latexrecommended texlive-latexextra texlive-fontsrecommended texlive-langspanish texlive-mathscience texlive-xetex texlive-luatex texlive-binextra texlive-bibtexextra biber" ;;
    zypper) echo "texlive-scheme-medium texlive-latexmk texlive-synctex texlive-texcount" ;;
  esac
}

# Paquete que provee cada herramienta/archivo TeX suelto.
pkg_for() {
  case "$PM:$1" in
    dnf:latexmk)     echo latexmk ;;
    dnf:synctex)     echo texlive-synctex ;;
    dnf:texcount)    echo texlive-texcount ;;
    dnf:xelatex)     echo texlive-xetex ;;
    dnf:lualatex)    echo texlive-luatex ;;
    dnf:spanish.ldf) echo texlive-babel-spanish ;;
    dnf:beamer.cls)  echo texlive-beamer ;;
    apt:latexmk)     echo latexmk ;;
    apt:synctex)     echo texlive-binaries ;;
    apt:texcount)    echo texlive-extra-utils ;;
    apt:xelatex)     echo texlive-xetex ;;
    apt:lualatex)    echo texlive-luatex ;;
    apt:spanish.ldf) echo texlive-lang-spanish ;;
    apt:beamer.cls)  echo texlive-latex-recommended ;;
    pacman:latexmk|pacman:texcount) echo texlive-binextra ;;
    pacman:synctex)  echo texlive-bin ;;
    pacman:xelatex)  echo texlive-xetex ;;
    pacman:lualatex) echo texlive-luatex ;;
    pacman:spanish.ldf) echo texlive-langspanish ;;
    pacman:beamer.cls)  echo texlive-latexextra ;;
    zypper:*)        echo "texlive-$1" ;;
  esac
}

pm_install() {
  case "$PM" in
    dnf)    sudo dnf install -y "$@" ;;
    apt)    sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y "$@" ;;
    pacman) sudo pacman -S --needed --noconfirm "$@" ;;
    zypper) sudo zypper --non-interactive install "$@" ;;
  esac
}

pm_installed() {
  case "$PM" in
    dnf|zypper) rpm -q "$1" >/dev/null 2>&1 ;;
    apt)        dpkg -s "$1" >/dev/null 2>&1 ;;
    pacman)     pacman -Qi "$1" >/dev/null 2>&1 ;;
  esac
}

# ------------------------------------------------------------ verificación --
MISSING_SYS=()
MISSING_TEX=()
NEED_TEX_FULL=0
NEED_RUST=0
NEED_NODE=0
NEED_PNPM=0
NEED_MODULES=0

check_all() {
  MISSING_SYS=() MISSING_TEX=() NEED_TEX_FULL=0 NEED_RUST=0 NEED_NODE=0 NEED_PNPM=0 NEED_MODULES=0

  title "Sistema"
  info "Distribución: $DISTRO${PM:+ (gestor: $PM)}"
  [[ -z "$PM" ]] && warn "Distribución no soportada automáticamente: instala las dependencias de Tauri a mano (https://tauri.app/start/prerequisites/)."

  title "Librerías de escritorio (Tauri / WebKitGTK)"
  if [[ -n "$PM" ]]; then
    local p
    for p in $(pkgs_system); do
      if pm_installed "$p"; then ok "$p"; else miss "$p"; MISSING_SYS+=("$p"); fi
    done
  fi

  title "TeX"
  if has pdflatex; then
    ok "$(pdflatex --version | head -1)"
    local t
    for t in latexmk synctex xelatex lualatex texcount; do
      if has "$t"; then ok "$t"; else miss "$t"; MISSING_TEX+=("$(pkg_for "$t")"); fi
    done
    for t in spanish.ldf beamer.cls amsmath.sty geometry.sty hyperref.sty; do
      if kpsewhich "$t" >/dev/null 2>&1; then ok "$t"; else miss "$t"; [[ -n "$(pkg_for "$t")" ]] && MISSING_TEX+=("$(pkg_for "$t")") || NEED_TEX_FULL=1; fi
    done
  else
    miss "TeX Live no está instalado"
    NEED_TEX_FULL=1
  fi

  title "Herramientas de desarrollo"
  if has cargo; then ok "Rust $(rustc --version | cut -d' ' -f2)"; else miss "Rust (cargo)"; NEED_RUST=1; fi
  if has node; then
    local major; major="$(node -p 'process.versions.node.split(".")[0]')"
    if (( major >= 20 )); then ok "Node $(node --version)"; else miss "Node $(node --version) (se necesita ≥ 20)"; NEED_NODE=1; fi
  else
    miss "Node.js"; NEED_NODE=1
  fi
  if has pnpm; then ok "pnpm $(pnpm --version)"; else miss "pnpm"; NEED_PNPM=1; fi
  if [[ -d "$DIR/node_modules/@tauri-apps/cli" ]]; then ok "dependencias del proyecto (node_modules)"; else miss "dependencias del proyecto"; NEED_MODULES=1; fi

  title "Aplicación"
  if [[ -x "$BIN_DIR/$APP_ID" ]]; then ok "instalada en $BIN_DIR/$APP_ID"; else info "aún no compilada/instalada"; fi
}

needs_sudo() {
  (( ${#MISSING_SYS[@]} || ${#MISSING_TEX[@]} || NEED_TEX_FULL || NEED_NODE ))
}

# -------------------------------------------------------------- instalación --
install_deps() {
  title "Instalando dependencias"
  : >"$LOG"

  if needs_sudo; then
    [[ -z "$PM" ]] && die "No sé instalar paquetes en esta distribución."
    info "Se necesita tu contraseña para instalar paquetes del sistema."
    sudo -v || die "No se obtuvo permiso de administrador."
    # Mantiene viva la sesión de sudo mientras dura la instalación.
    ( while true; do sudo -n true; sleep 50; kill -0 "$$" 2>/dev/null || exit; done ) 2>/dev/null &
    SUDO_KEEPALIVE=$!
    trap 'kill $SUDO_KEEPALIVE 2>/dev/null' EXIT
  fi

  if (( ${#MISSING_SYS[@]} )); then
    run "Librerías de escritorio (${#MISSING_SYS[@]} paquetes)" pm_install "${MISSING_SYS[@]}" || die "Falló la instalación de librerías del sistema."
  fi

  if (( NEED_TEX_FULL )); then
    # shellcheck disable=SC2046
    run "TeX Live (puede tardar varios minutos)" pm_install $(pkgs_tex_full) || die "Falló la instalación de TeX Live."
  elif (( ${#MISSING_TEX[@]} )); then
    local uniq; uniq=$(printf "%s\n" "${MISSING_TEX[@]}" | sort -u | tr '\n' ' ')
    # shellcheck disable=SC2086
    run "Complementos de TeX: $uniq" pm_install $uniq || die "Falló la instalación de complementos TeX."
  fi

  if (( NEED_NODE )); then
    run "Node.js" pm_install nodejs npm || die "Falló la instalación de Node.js."
  fi

  if (( NEED_RUST )); then
    run "Rust (rustup, en tu usuario)" sh -c "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal" \
      || die "Falló la instalación de Rust."
    # shellcheck disable=SC1091
    . "$HOME/.cargo/env"
  fi

  if (( NEED_PNPM )); then
    mkdir -p "$BIN_DIR"
    run "pnpm (en $BIN_DIR)" sh -c "corepack enable --install-directory '$BIN_DIR' pnpm 2>/dev/null || npm install -g --prefix '$HOME/.local' pnpm" \
      || die "Falló la instalación de pnpm."
  fi

  cd "$DIR" || die "No se pudo entrar a $DIR"
  run "Dependencias del proyecto (pnpm install)" pnpm install --frozen-lockfile=false || die "Falló pnpm install."
}

build_app() {
  title "Compilando $APP_NAME"
  cd "$DIR" || exit 1
  info "La primera compilación de Rust tarda unos minutos; las siguientes son rápidas."
  run "Compilando en modo release" pnpm tauri build --no-bundle || die "Falló la compilación."

  local bin="$DIR/src-tauri/target/release/$APP_ID"
  [[ -x "$bin" ]] || die "No se encontró el binario en $bin"

  mkdir -p "$BIN_DIR" "$DESKTOP_DIR" "$ICON_DIR"
  install -m 755 "$bin" "$BIN_DIR/$APP_ID-bin"

  # Lanzador: WebKitGTK muestra la ventana en blanco con algunos drivers NVIDIA.
  {
    echo '#!/usr/bin/env bash'
    if lsmod 2>/dev/null | grep -q '^nvidia'; then
      echo 'export WEBKIT_DISABLE_DMABUF_RENDERER=1'
    fi
    echo "exec \"$BIN_DIR/$APP_ID-bin\" \"\$@\""
  } >"$BIN_DIR/$APP_ID"
  chmod 755 "$BIN_DIR/$APP_ID"

  install -m 644 "$DIR/src-tauri/icons/128x128.png" "$ICON_DIR/$APP_ID.png"
  cat >"$DESKTOP_DIR/$APP_ID.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=$APP_NAME
GenericName=Editor LaTeX
Comment=Editor LaTeX local estilo Overleaf
Exec=$BIN_DIR/$APP_ID %F
Icon=$APP_ID
Terminal=false
Categories=Office;Publishing;TextEditor;
Keywords=latex;tex;pdf;overleaf;
StartupWMClass=$APP_ID
EOF
  has update-desktop-database && update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1
  ok "Instalada: búscala como «$APP_NAME» en tu menú de aplicaciones"
  ok "O ejecútala con: $APP_ID"
  case ":$PATH:" in *":$BIN_DIR:"*) ;; *) warn "$BIN_DIR no está en tu PATH; agrega: export PATH=\"\$HOME/.local/bin:\$PATH\"" ;; esac
}

smoke_test() {
  title "Prueba de compilación LaTeX"
  local tmp; tmp="$(mktemp -d)"
  cat >"$tmp/prueba.tex" <<'EOF'
\documentclass{article}
\usepackage[spanish]{babel}
\usepackage{amsmath}
\begin{document}
Prueba: $e^{i\pi}+1=0$.
\end{document}
EOF
  if (cd "$tmp" && latexmk -pdf -interaction=nonstopmode -synctex=1 prueba.tex >>"$LOG" 2>&1) && [[ -f "$tmp/prueba.pdf" ]]; then
    ok "latexmk + pdfLaTeX generan PDF correctamente"
  else
    miss "La compilación de prueba falló (revisa $LOG)"
  fi
  rm -rf "$tmp"
}

uninstall() {
  title "Desinstalando"
  rm -f "$BIN_DIR/$APP_ID" "$BIN_DIR/$APP_ID-bin" "$DESKTOP_DIR/$APP_ID.desktop" "$ICON_DIR/$APP_ID.png"
  ok "Se quitó el binario y el acceso directo (tus proyectos no se tocan)."
}

do_all() {
  check_all
  install_deps
  smoke_test
  build_app
  title "${G}¡Listo!${N}"
}

menu() {
  banner
  check_all
  echo
  printf "${B}¿Qué quieres hacer?${N}\n"
  echo "  1) Instalar todo y crear acceso directo (recomendado)"
  echo "  2) Solo instalar dependencias"
  echo "  3) Abrir en modo desarrollo (recarga en caliente)"
  echo "  4) Desinstalar acceso directo"
  echo "  5) Salir"
  read -rp "> " opt
  case "$opt" in
    1|"") install_deps; smoke_test; build_app; title "${G}¡Listo!${N}" ;;
    2) install_deps; smoke_test; title "${G}Dependencias listas.${N} Ejecuta ./instalar.sh --dev para probar." ;;
    3) cd "$DIR" && exec pnpm tauri dev ;;
    4) uninstall ;;
    *) exit 0 ;;
  esac
}

detect_distro
case "${1:-}" in
  --todo|-y)       banner; do_all ;;
  --verificar|-c)  banner; check_all ;;
  --dev)           check_all >/dev/null; if needs_sudo || (( NEED_RUST || NEED_PNPM || NEED_MODULES )); then banner; check_all; install_deps; fi; cd "$DIR" && exec pnpm tauri dev ;;
  --desinstalar)   uninstall ;;
  -h|--help)       sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//' ;;
  "")              menu ;;
  *)               echo "Opción desconocida: $1 (usa --help)"; exit 1 ;;
esac
