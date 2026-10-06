# LocalTeX

Editor de LaTeX de escritorio al estilo Overleaf que funciona **100 % en local**: escribes a la izquierda y ves el PDF a la derecha. Compila con tu propio TeX Live, no necesita internet ni cuenta, y trabaja directamente sobre carpetas de tu disco, así que puedes usar git u otros editores en los mismos archivos.

**Tecnología:** Tauri 2 (backend en Rust) · TypeScript + Vite · CodeMirror 6 (editor) · pdf.js (visor) · `latexmk` + SyncTeX.

---

## Primera ejecución

### 1. Instalar

Desde la carpeta del proyecto:

```bash
./instalar.sh
```

En el menú elige **1) Instalar todo**. El script:

- detecta tu distribución (Fedora, Debian/Ubuntu, Arch u openSUSE);
- instala **solo lo que falta**: librerías de WebKitGTK, TeX Live, Rust, Node y pnpm (pide la contraseña de sudo una sola vez);
- compila un documento de prueba para confirmar que LaTeX funciona;
- compila la app y la agrega a tu menú de aplicaciones.

La primera compilación tarda unos minutos; las siguientes son rápidas. Si algo falla, el detalle queda en `instalar.log`.

> Para solo revisar qué falta, sin instalar nada: `./instalar.sh --verificar`

### 2. Abrir la app

Búscala como **LocalTeX** en el menú de aplicaciones, o ejecuta `localtex` en la terminal.

### 3. Crear o abrir un proyecto

En la pantalla de inicio:

- **Nuevo proyecto**: elige el nombre, la ubicación y una plantilla (Artículo, Informe/Tesis, Presentación Beamer o En blanco).
- **Abrir carpeta**: cualquier carpeta que ya tenga archivos `.tex`.

La app detecta sola el archivo principal (el que contiene `\documentclass`) y compila. Los proyectos abiertos aparecen en **Recientes**, y la próxima vez se reabre el último.

### 4. Elegir cómo se actualiza el PDF

En la barra superior hay dos modos:

| Modo | Comportamiento |
|---|---|
| ⚡ **Auto** | Guarda y recompila automáticamente cuando dejas de escribir (estilo *live server*). |
| ⌨ **Ctrl+S** | Solo recompila al guardar con `Ctrl+S` (como Overleaf). |

El retardo del modo Auto se ajusta en ⚙ **Ajustes**.

### 5. Revisar el motor

Si tu documento usa `fontspec` o fuentes del sistema, cambia el **Motor** a XeLaTeX o LuaLaTeX. La app intenta detectarlo sola al abrir el proyecto.

---

## Uso diario

| Acción | Cómo |
|---|---|
| Compilar | `Ctrl+Enter` o el botón **Compilar** |
| Guardar | `Ctrl+S` |
| Ir del código al PDF | `Ctrl+J` o el botón → del visor |
| Ir del PDF al código | Doble clic en el PDF |
| Abrir archivo rápido | `Ctrl+P` |
| Negrita / cursiva / subrayado | `Ctrl+B` / `Ctrl+I` / `Ctrl+U` |
| Comentar líneas | `Ctrl+/` |
| Buscar / reemplazar | `Ctrl+F` / `Ctrl+H` |
| Autocompletar | `Ctrl+Espacio` (también aparece solo al escribir `\`) |
| Zoom del PDF | `Ctrl+rueda` o los botones del visor |
| Renombrar archivo | `F2` o clic derecho en el árbol |

- **Errores**: el contador junto a Compilar y el icono de terminal abren el panel de errores. Haz clic en uno para ir a la línea; los errores también aparecen marcados en el editor.
- **Autocompletado**: sugiere comandos, entornos (`\begin{…}`), etiquetas en `\ref{…}`, claves de tus `.bib` en `\cite{…}` y rutas en `\includegraphics{…}` o `\input{…}`.
- **Archivos**: clic derecho en el árbol para crear, renombrar, eliminar o marcar el archivo principal. También puedes **arrastrar imágenes** desde tu explorador al árbol.
- **Exportar**: el botón de descarga guarda una copia del PDF donde quieras.
- **Cambios externos**: si editas archivos con git u otro editor, la app los recarga al volver a la ventana.

## Dónde quedan las cosas

- **Tus archivos** quedan tal cual en tu carpeta. La app no la ensucia con `.aux`, `.log`, etc.
- **Los archivos de compilación** se guardan en `~/.cache/pe.edu.utec.localtex/builds/`. Si algo se compila raro, usa **Compilar ▾ → Recompilar desde cero**.

## Desarrollo

```bash
./instalar.sh --dev          # app con recarga en caliente
pnpm tauri build             # paquetes .rpm / .deb / AppImage
./instalar.sh --desinstalar  # quita la app y el acceso directo
```

Estructura del código:

```
src/              frontend (TypeScript)
  main.ts         orquestación: proyectos, modos, compilación, UI
  editor.ts       configuración de CodeMirror
  latex.ts        autocompletado y esquema del documento
  pdfview.ts      visor PDF sin parpadeo + SyncTeX
  logparser.ts    interpreta el .log de TeX
src-tauri/src/    backend (Rust): archivos, latexmk, synctex, texcount
instalar.sh       instalador
```

## Problemas comunes

- **Ventana en blanco al abrir** (frecuente con NVIDIA): ejecuta `WEBKIT_DISABLE_DMABUF_RENDERER=1 localtex`. El instalador ya lo configura si detecta un driver NVIDIA.
- **«Falta un paquete .sty»**: instálalo con tu gestor; por ejemplo, en Fedora `sudo dnf install 'tex(nombre.sty)'`.
- **`localtex: command not found`**: agrega `~/.local/bin` a tu `PATH`.
