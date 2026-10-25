"""Build the offline copy: one HTML file holding the whole app (code, styles, fonts, icons and every
data file). It opens straight from disk, with no server, no install and no internet, so it can be
copied, emailed or put on a USB stick.

Usage: python -I src/build_offline.py web dist/interop-mapper.html
Run export_web.py first; the copy holds whatever web/data holds.
"""
import base64
import gzip
import hashlib
import html
import json
import os
import re
import sys

# app.js imports these modules; in the copy each becomes an object its imports are read from.
MODULES = {"./lib.js": "__lib", "./codegen.js": "__codegen"}
FONT_RE = re.compile(r'url\("(fonts/[^"]+\.woff2)"\)')

# Reads the data packed into the page, where each file is gzip-compressed and base64-encoded.
LOADER = """window.interopData = (() => {
  let files = null;
  return {
    load(path) {
      files ??= JSON.parse(document.getElementById("interop-data").textContent);
      if (!(path in files)) return Promise.reject(new Error(`Couldn't load ${path}: it isn't in this copy`));
      const bytes = Uint8Array.from(atob(files[path]), (c) => c.charCodeAt(0));
      return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).json();
    },
  };
})();"""


def text(web, rel):
    with open(os.path.join(web, rel), encoding="utf-8") as f:
        return f.read()


def data_uri(web, rel, mime):
    with open(os.path.join(web, rel), "rb") as f:
        return f"data:{mime};base64,{base64.b64encode(f.read()).decode()}"


def as_module(src, var):
    """A module's code wrapped so its exports become one object, letting modules share a script."""
    names = re.findall(r"^export (?:async )?(?:function|const|let|class) (\w+)", src, re.M)
    body = re.sub(r"^export ", "", src, flags=re.M)
    return f"const {var} = (() => {{\n{body}\nreturn {{ {', '.join(names)} }};\n}})();\n"


def app_script(web):
    app = re.sub(r'import\s*\{([^}]*)\}\s*from\s*"([^"]+)";',
                 lambda m: f"const {{{m.group(1)}}} = {MODULES[m.group(2)]};", text(web, "app.js"))
    if re.search(r"^\s*(import|export)\b", app, re.M):
        raise ValueError("app.js has an import or export this build doesn't handle")
    return "".join(as_module(text(web, path[2:]), var) for path, var in MODULES.items()) + app


def inline_safe(code, what):
    if re.search(r"</script|<!--", code, re.I):
        raise ValueError(f"{what} contains text that would end an inline <script> early")
    return code


def csp_hash(code):
    return f"'sha256-{base64.b64encode(hashlib.sha256(code.encode()).digest()).decode()}'"


def packed_data(web):
    """Every data file the app can ask for, as {"R4/index.json": base64(gzip(bytes))}."""
    files = {}
    for rel in json.loads(text(web, "data/files.json"))["files"]:
        with open(os.path.join(web, rel), "rb") as f:
            files[rel.removeprefix("data/")] = base64.b64encode(gzip.compress(f.read(), 9, mtime=0)).decode()
    return files


def swap(page, old, new, count=1):
    found = page.count(old)
    if found != count:
        raise ValueError(f"index.html has {found} of {old!r}, expected {count}; update build_offline.py")
    return page.replace(old, new)


def build(web, out):
    icon = data_uri(web, "icons/icon-192.png", "image/png")
    css = FONT_RE.sub(lambda m: f'url("{data_uri(web, m.group(1), "font/woff2")}")',
                      text(web, "tokens.css") + "\n" + text(web, "style.css"))
    theme = inline_safe(text(web, "theme.js"), "theme.js")
    app = inline_safe(app_script(web), "app.js")
    # Nothing outside the page is allowed: scripts and styles by their exact hash, fonts and icons inline.
    csp = (f"default-src 'none'; script-src {csp_hash(theme)} {csp_hash(LOADER)} {csp_hash(app)}; "
           f"style-src {csp_hash(css)}; font-src data:; img-src data:; connect-src 'none'; "
           "base-uri 'none'; form-action 'none'")

    page = text(web, "index.html")
    page, n = re.subn(r'<meta http-equiv="Content-Security-Policy"\s+content="[^"]*">',
                      f'<meta http-equiv="Content-Security-Policy" content="{csp}">', page)
    if n != 1:
        raise ValueError("index.html has no Content-Security-Policy meta; update build_offline.py")
    page = swap(page, '  <link rel="manifest" href="manifest.webmanifest">\n', "")
    page = swap(page, '"icons/icon-192.png"', f'"{icon}"', count=3)
    page = swap(page, '<script src="theme.js"></script>', f"<script>{theme}</script>")
    page = swap(page, '<link rel="stylesheet" href="tokens.css">', f"<style>{css}</style>")
    page = swap(page, '  <link rel="stylesheet" href="style.css">\n', "")
    page = swap(page, '<script type="module" src="app.js"></script>',
                f'<script>{LOADER}</script>\n  <script type="module">{app}</script>')
    # The font licence travels with the fonts.
    page = swap(page, '<a href="fonts/OFL.txt">SIL Open Font License</a>.</p>',
                "SIL Open Font License, included below.</p>\n"
                f'        <details class="ofl"><summary>Font license</summary><pre>{html.escape(text(web, "fonts/OFL.txt"))}</pre></details>')
    data = json.dumps(packed_data(web), separators=(",", ":"))
    page = swap(page, "</body>", f'<script type="application/json" id="interop-data">{data}</script>\n</body>')

    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        f.write(page)
    print(f"{out}: {os.path.getsize(out) / 1048576:.1f} MB, opens from disk with no server")


if __name__ == "__main__":
    build(sys.argv[1], sys.argv[2])
